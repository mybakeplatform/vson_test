/**
 * Availability engine.
 *
 * Bands, for a product with soft=45, hard=50, overflow=3 (max = 53):
 *   committed_after <= 45  NORMAL
 *   committed_after <= 50  SOFT      (past the soft threshold, still fine)
 *   committed_after <= 53  OVERFLOW  (inside the allowance)
 *   committed_after >  53  rejected outright
 *
 * A request is all-or-nothing. 53 committed + a request for 1 is a REJECT, not
 * a partial accept, and 50 + 3 is a single ACCEPT for all three units.
 * The decision is taken here, on the server, under a row lock.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent } from '../events.js';
import { notFound, unprocessable } from '../http/errors.js';

export type Band = 'NORMAL' | 'SOFT' | 'OVERFLOW' | 'OVER_MAX' | 'RELEASE';

export interface Policy {
  product_id: string;
  soft_threshold: number;
  hard_limit: number;
  overflow_allowance: number;
  max_units: number;
}

export interface AvailabilityDecision {
  id: string;
  outcome: 'ACCEPT' | 'REJECT' | 'RELEASE';
  band: Band;
  requestedUnits: number;
  committedBefore: number;
  committedAfter: number;
  remaining: number;
  reason: string;
  policy: Policy;
}

export async function loadPolicy(client: PoolClient, productId: string): Promise<Policy> {
  const policy = await one<Policy>(
    `SELECT product_id, soft_threshold, hard_limit, overflow_allowance, max_units
       FROM availability_policies WHERE product_id = $1`,
    [productId],
    client,
  );
  if (!policy) throw notFound(`No availability policy for product ${productId}`);
  return policy;
}

/** Lock (creating if needed) the counter row for one product-day. */
async function lockDay(
  client: PoolClient,
  bakeryId: string,
  productId: string,
  serviceDate: string,
): Promise<{ id: string; committed_units: number }> {
  await client.query(
    `INSERT INTO availability_days (bakery_id, product_id, service_date)
     VALUES ($1, $2, $3) ON CONFLICT (product_id, service_date) DO NOTHING`,
    [bakeryId, productId, serviceDate],
  );
  const row = await one<{ id: string; committed_units: number }>(
    `SELECT id, committed_units FROM availability_days
      WHERE product_id = $1 AND service_date = $2 FOR UPDATE`,
    [productId, serviceDate],
    client,
  );
  return row!;
}

function bandFor(policy: Policy, committedAfter: number): Band {
  if (committedAfter > policy.max_units) return 'OVER_MAX';
  if (committedAfter > policy.hard_limit) return 'OVERFLOW';
  if (committedAfter > policy.soft_threshold) return 'SOFT';
  return 'NORMAL';
}

interface ReserveInput {
  bakeryId: string;
  productId: string;
  serviceDate: string;
  quantity: number;
  actorUserId: string | null;
  orderId?: string | null;
}

/**
 * Evaluate a request and, if accepted, consume the capacity atomically.
 * Always writes an availability_decisions row - rejections are evidence too.
 */
export async function reserve(
  client: PoolClient,
  input: ReserveInput,
): Promise<AvailabilityDecision> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw unprocessable('INVALID_QUANTITY', 'Quantity must be a positive whole number');
  }
  const policy = await loadPolicy(client, input.productId);
  const day = await lockDay(client, input.bakeryId, input.productId, input.serviceDate);

  const before = day.committed_units;
  const proposed = before + input.quantity;
  const overMax = proposed > policy.max_units;
  const band = overMax ? 'OVER_MAX' : bandFor(policy, proposed);
  const after = overMax ? before : proposed;

  const reason = overMax
    ? `Rejected: ${before} committed + ${input.quantity} requested = ${proposed}, over max ${policy.max_units} (hard ${policy.hard_limit} + overflow ${policy.overflow_allowance}). No partial acceptance.`
    : `Accepted ${input.quantity} unit(s) in band ${band}: ${before} -> ${proposed} of max ${policy.max_units}.`;

  if (!overMax) {
    await client.query('UPDATE availability_days SET committed_units = $2 WHERE id = $1', [
      day.id,
      after,
    ]);
  }

  const decision = await one<{ id: string }>(
    `INSERT INTO availability_decisions
       (bakery_id, product_id, service_date, requested_units, committed_before, committed_after,
        outcome, band, reason, soft_threshold, hard_limit, overflow_allowance, max_units,
        actor_user_id, order_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      input.quantity,
      before,
      after,
      overMax ? 'REJECT' : 'ACCEPT',
      band,
      reason,
      policy.soft_threshold,
      policy.hard_limit,
      policy.overflow_allowance,
      policy.max_units,
      input.actorUserId,
      input.orderId ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: overMax ? 'availability.rejected' : 'availability.accepted',
    entityType: 'availability_day',
    entityId: day.id,
    actorUserId: input.actorUserId,
    payload: {
      productId: input.productId,
      serviceDate: input.serviceDate,
      requested: input.quantity,
      committedBefore: before,
      committedAfter: after,
      band,
    },
  });

  return {
    id: decision!.id,
    outcome: overMax ? 'REJECT' : 'ACCEPT',
    band,
    requestedUnits: input.quantity,
    committedBefore: before,
    committedAfter: after,
    remaining: policy.max_units - after,
    reason,
    policy,
  };
}

/** Give capacity back (order cancelled, delivery rescheduled to another day). */
export async function release(
  client: PoolClient,
  input: Omit<ReserveInput, 'quantity'> & { quantity: number; note?: string },
): Promise<AvailabilityDecision> {
  const policy = await loadPolicy(client, input.productId);
  const day = await lockDay(client, input.bakeryId, input.productId, input.serviceDate);
  const before = day.committed_units;
  const after = Math.max(0, before - input.quantity);

  await client.query('UPDATE availability_days SET committed_units = $2 WHERE id = $1', [
    day.id,
    after,
  ]);

  const reason = input.note ?? `Released ${input.quantity} unit(s): ${before} -> ${after}.`;
  const decision = await one<{ id: string }>(
    `INSERT INTO availability_decisions
       (bakery_id, product_id, service_date, requested_units, committed_before, committed_after,
        outcome, band, reason, soft_threshold, hard_limit, overflow_allowance, max_units,
        actor_user_id, order_id)
     VALUES ($1,$2,$3,$4,$5,$6,'RELEASE','RELEASE',$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      -input.quantity,
      before,
      after,
      reason,
      policy.soft_threshold,
      policy.hard_limit,
      policy.overflow_allowance,
      policy.max_units,
      input.actorUserId,
      input.orderId ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'availability.released',
    entityType: 'availability_day',
    entityId: day.id,
    actorUserId: input.actorUserId,
    payload: {
      productId: input.productId,
      serviceDate: input.serviceDate,
      released: input.quantity,
      committedBefore: before,
      committedAfter: after,
    },
  });

  return {
    id: decision!.id,
    outcome: 'RELEASE',
    band: 'RELEASE',
    requestedUnits: -input.quantity,
    committedBefore: before,
    committedAfter: after,
    remaining: policy.max_units - after,
    reason,
    policy,
  };
}

/** Read-only view for the console. */
export async function snapshot(
  client: PoolClient,
  bakeryId: string,
  productId: string,
  serviceDate: string,
) {
  const policy = await loadPolicy(client, productId);
  const day = await one<{ committed_units: number }>(
    'SELECT committed_units FROM availability_days WHERE product_id = $1 AND service_date = $2',
    [productId, serviceDate],
    client,
  );
  const committed = day?.committed_units ?? 0;
  const decisions = await query(
    `SELECT requested_units, committed_before, committed_after, outcome, band, reason, created_at
       FROM availability_decisions
      WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3
      ORDER BY created_at, id`,
    [bakeryId, productId, serviceDate],
    client,
  );
  return {
    policy,
    committed,
    remaining: policy.max_units - committed,
    band: bandFor(policy, committed),
    decisions,
  };
}
