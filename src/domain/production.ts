/**
 * Production planning, runs, allocation and failure handling.
 *
 * Two rules drive the tests here:
 *   1. Actual output never rewrites customer demand. Required stays 65 when
 *      the mixers happen to yield 68; the extra 3 become surplus inventory.
 *   2. A failed run never cancels a customer. It records who is affected and
 *      waits for a human to decide.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { notFound, unprocessable } from '../http/errors.js';

/**
 * Split a planned quantity into as few mixer loads as possible, balanced,
 * never exceeding the mixer's capacity. 65 with a 33 mixer -> [32, 33].
 */
export function splitMixerLoads(plannedUnits: number, maxLoad: number): number[] {
  if (plannedUnits <= 0) return [];
  if (maxLoad <= 0) throw unprocessable('INVALID_MIXER', 'Max mixer load must be positive');
  const loads = Math.ceil(plannedUnits / maxLoad);
  const base = Math.floor(plannedUnits / loads);
  const remainder = plannedUnits % loads;
  return Array.from({ length: loads }, (_, i) => base + (i >= loads - remainder ? 1 : 0));
}

async function currentRecipeVersion(client: PoolClient, productId: string) {
  const row = await one<{ id: string; version: number; recipe_id: string }>(
    `SELECT rv.id, rv.version, rv.recipe_id
       FROM recipe_versions rv
       JOIN recipes r ON r.id = rv.recipe_id
      WHERE r.product_id = $1 AND rv.superseded_at IS NULL`,
    [productId],
    client,
  );
  if (!row) throw notFound(`No current recipe version for product ${productId}`);
  return row;
}

export interface PlanInput {
  bakeryId: string;
  actorUserId: string;
  productId: string;
  serviceDate: string;
  maxMixerLoad: number;
  /** Defaults to the sum of open demand for the product-day. */
  requiredUnits?: number;
  /** Defaults to requiredUnits. Planning more than required is allowed. */
  plannedUnits?: number;
  scenarioTag?: string | null;
}

export async function createPlan(client: PoolClient, input: PlanInput) {
  const demand = await one<{ total: number }>(
    `SELECT coalesce(sum(quantity), 0)::int AS total FROM production_demands
      WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3 AND status = 'OPEN'`,
    [input.bakeryId, input.productId, input.serviceDate],
    client,
  );
  const required = input.requiredUnits ?? demand!.total;
  const planned = input.plannedUnits ?? required;
  const recipe = await currentRecipeVersion(client, input.productId);

  const plan = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO production_plans
       (bakery_id, product_id, service_date, required_units, planned_units, max_mixer_load,
        recipe_version_id, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      required,
      planned,
      input.maxMixerLoad,
      recipe.id,
      input.scenarioTag ?? null,
    ],
    client,
  );

  const loads = splitMixerLoads(planned, input.maxMixerLoad);
  for (const [index, units] of loads.entries()) {
    await client.query(
      'INSERT INTO mixer_loads (bakery_id, plan_id, sequence, planned_units) VALUES ($1,$2,$3,$4)',
      [input.bakeryId, plan!.id, index + 1, units],
    );
  }

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'production.planned',
    entityType: 'production_plan',
    entityId: plan!.id,
    actorUserId: input.actorUserId,
    payload: {
      requiredUnits: required,
      plannedUnits: planned,
      maxMixerLoad: input.maxMixerLoad,
      mixerLoads: loads,
      recipeVersion: recipe.version,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'production.plan',
    entityType: 'production_plan',
    entityId: plan!.id,
    afterState: { required, planned, loads, recipeVersionId: recipe.id },
  });

  return { plan: plan!, mixerLoads: loads, recipeVersionId: recipe.id };
}

/**
 * Record what actually came out of the oven and allocate it against demand,
 * oldest commitment first. Output above required demand is surplus; it is
 * never back-written into what the customer asked for.
 */
export async function completeRun(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; planId: string; actualUnits: number },
) {
  const plan = await one<{
    id: string;
    bakery_id: string;
    product_id: string;
    service_date: string;
    required_units: number;
    planned_units: number;
    recipe_version_id: string;
    status: string;
  }>('SELECT * FROM production_plans WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.planId,
    input.bakeryId,
  ], client);
  if (!plan) throw notFound('Production plan not found');
  if (plan.status === 'COMPLETED' || plan.status === 'FAILED') {
    throw unprocessable('PLAN_CLOSED', `Plan is already ${plan.status}`);
  }

  const run = await one<{ id: string }>(
    `INSERT INTO production_runs
       (bakery_id, plan_id, product_id, service_date, recipe_version_id, actual_units, status)
     VALUES ($1,$2,$3,$4,$5,$6,'IN_PROGRESS') RETURNING id`,
    [
      input.bakeryId,
      plan.id,
      plan.product_id,
      plan.service_date,
      plan.recipe_version_id,
      input.actualUnits,
    ],
    client,
  );

  const commitments = await query<{ id: string; quantity: number; order_id: string }>(
    `SELECT id, quantity, order_id FROM commitments
      WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3 AND status IN ('OPEN','AT_RISK')
      ORDER BY created_at, id`,
    [input.bakeryId, plan.product_id, plan.service_date],
    client,
  );

  let remaining = input.actualUnits;
  let allocated = 0;
  const shortfalls: { commitmentId: string; orderId: string; shortfall: number }[] = [];

  for (const commitment of commitments) {
    const give = Math.min(remaining, commitment.quantity);
    if (give > 0) {
      await client.query(
        'INSERT INTO production_allocations (bakery_id, run_id, commitment_id, quantity) VALUES ($1,$2,$3,$4)',
        [input.bakeryId, run!.id, commitment.id, give],
      );
      allocated += give;
      remaining -= give;
    }
    const status = give >= commitment.quantity ? 'FULFILLED' : give > 0 ? 'PARTIALLY_FULFILLED' : 'AT_RISK';
    await client.query('UPDATE commitments SET status = $2 WHERE id = $1', [commitment.id, status]);
    if (status === 'FULFILLED') {
      await client.query(
        "UPDATE production_demands SET status = 'FULFILLED' WHERE commitment_id = $1 AND status = 'OPEN'",
        [commitment.id],
      );
    } else {
      shortfalls.push({
        commitmentId: commitment.id,
        orderId: commitment.order_id,
        shortfall: commitment.quantity - give,
      });
    }
  }

  const surplus = remaining;
  if (surplus > 0) {
    await client.query(
      `INSERT INTO surplus_inventory (bakery_id, run_id, product_id, service_date, quantity)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.bakeryId, run!.id, plan.product_id, plan.service_date, surplus],
    );
  }

  const runStatus = shortfalls.length > 0 ? 'PARTIAL' : 'COMPLETED';
  await client.query(
    `UPDATE production_runs
        SET allocated_units = $2, surplus_units = $3, status = $4, completed_at = now()
      WHERE id = $1`,
    [run!.id, allocated, surplus, runStatus],
  );
  await client.query('UPDATE production_plans SET status = $2 WHERE id = $1', [
    plan.id,
    runStatus === 'PARTIAL' ? 'IN_PROGRESS' : 'COMPLETED',
  ]);

  for (const s of shortfalls) {
    await client.query(
      `INSERT INTO production_failure_impacts
         (bakery_id, run_id, commitment_id, order_id, shortfall_units)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id, commitment_id) DO NOTHING`,
      [input.bakeryId, run!.id, s.commitmentId, s.orderId, s.shortfall],
    );
  }

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'production.completed',
    entityType: 'production_run',
    entityId: run!.id,
    actorUserId: input.actorUserId,
    payload: {
      requiredUnits: plan.required_units,
      plannedUnits: plan.planned_units,
      actualUnits: input.actualUnits,
      allocatedUnits: allocated,
      surplusUnits: surplus,
      status: runStatus,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'production.complete',
    entityType: 'production_run',
    entityId: run!.id,
    afterState: { actual: input.actualUnits, allocated, surplus, status: runStatus },
  });

  return {
    runId: run!.id,
    requiredUnits: plan.required_units,
    plannedUnits: plan.planned_units,
    actualUnits: input.actualUnits,
    allocatedUnits: allocated,
    surplusUnits: surplus,
    status: runStatus,
    shortfalls,
  };
}

/**
 * The whole run failed. Record the affected commitments and stop. No order is
 * cancelled, no quantity is rewritten, nothing is auto-rescheduled.
 */
export async function failRun(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; planId: string; reason: string },
) {
  const plan = await one<{
    id: string;
    product_id: string;
    service_date: string;
    recipe_version_id: string;
    required_units: number;
  }>('SELECT * FROM production_plans WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.planId,
    input.bakeryId,
  ], client);
  if (!plan) throw notFound('Production plan not found');

  const run = await one<{ id: string }>(
    `INSERT INTO production_runs
       (bakery_id, plan_id, product_id, service_date, recipe_version_id, actual_units,
        allocated_units, surplus_units, status, failure_reason, completed_at)
     VALUES ($1,$2,$3,$4,$5,0,0,0,'FAILED',$6, now()) RETURNING id`,
    [input.bakeryId, plan.id, plan.product_id, plan.service_date, plan.recipe_version_id, input.reason],
    client,
  );

  const affected = await query<{ id: string; order_id: string; quantity: number }>(
    `SELECT id, order_id, quantity FROM commitments
      WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3 AND status IN ('OPEN','AT_RISK')
      ORDER BY created_at, id`,
    [input.bakeryId, plan.product_id, plan.service_date],
    client,
  );

  for (const c of affected) {
    await client.query(
      `INSERT INTO production_failure_impacts
         (bakery_id, run_id, commitment_id, order_id, shortfall_units)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (run_id, commitment_id) DO NOTHING`,
      [input.bakeryId, run!.id, c.id, c.order_id, c.quantity],
    );
    // AT_RISK, deliberately not CANCELLED: the customer still has an order.
    await client.query("UPDATE commitments SET status = 'AT_RISK' WHERE id = $1", [c.id]);
  }

  await client.query("UPDATE production_plans SET status = 'FAILED' WHERE id = $1", [plan.id]);

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'production.failed',
    entityType: 'production_run',
    entityId: run!.id,
    actorUserId: input.actorUserId,
    payload: {
      reason: input.reason,
      affectedCommitments: affected.length,
      affectedUnits: affected.reduce((sum, c) => sum + c.quantity, 0),
      customersCancelled: 0,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'production.fail',
    entityType: 'production_run',
    entityId: run!.id,
    afterState: { reason: input.reason, affected: affected.map((a) => a.id) },
  });

  return { runId: run!.id, affected };
}

/**
 * Split ONE commitment into several delivery segments (3 today + 3 later).
 * This is an operational split of the existing order, not a new order.
 */
export async function splitCommitment(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    commitmentId: string;
    segments: { quantity: number; plannedDate: string }[];
    reason: string;
    runId?: string | null;
  },
) {
  const commitment = await one<{
    id: string;
    order_id: string;
    quantity: number;
    product_id: string;
    bakery_id: string;
  }>('SELECT * FROM commitments WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.commitmentId,
    input.bakeryId,
  ], client);
  if (!commitment) throw notFound('Commitment not found');

  const total = input.segments.reduce((sum, s) => sum + s.quantity, 0);
  if (total !== commitment.quantity) {
    throw unprocessable(
      'SPLIT_MISMATCH',
      `Segments total ${total} but the commitment is for ${commitment.quantity}. A split may not change what the customer ordered.`,
    );
  }

  const existing = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM fulfillment_segments WHERE commitment_id = $1',
    [input.commitmentId],
    client,
  );
  if ((existing?.count ?? 0) > 0) {
    throw unprocessable('ALREADY_SPLIT', 'This commitment has already been split');
  }

  const created = [];
  for (const [index, segment] of input.segments.entries()) {
    const row = await one<Record<string, unknown>>(
      `INSERT INTO fulfillment_segments
         (bakery_id, commitment_id, order_id, sequence, quantity, planned_date, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        input.bakeryId,
        commitment.id,
        commitment.order_id,
        index + 1,
        segment.quantity,
        segment.plannedDate,
        input.reason,
      ],
      client,
    );
    created.push(row!);
  }

  if (input.runId) {
    await client.query(
      `UPDATE production_failure_impacts
          SET resolution = 'SPLIT_FULFILLMENT', resolved_at = now(), resolved_by = $3
        WHERE run_id = $1 AND commitment_id = $2`,
      [input.runId, commitment.id, input.actorUserId],
    );
  } else {
    await client.query(
      `UPDATE production_failure_impacts
          SET resolution = 'SPLIT_FULFILLMENT', resolved_at = now(), resolved_by = $2
        WHERE commitment_id = $1 AND resolution = 'AWAITING_HUMAN'`,
      [commitment.id, input.actorUserId],
    );
  }

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'commitment.split',
    entityType: 'commitment',
    entityId: commitment.id,
    actorUserId: input.actorUserId,
    payload: {
      orderId: commitment.order_id,
      originalQuantity: commitment.quantity,
      segments: input.segments,
      reason: input.reason,
      newOrdersCreated: 0,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'commitment.split',
    entityType: 'commitment',
    entityId: commitment.id,
    beforeState: { quantity: commitment.quantity, segments: 0 },
    afterState: { quantity: commitment.quantity, segments: input.segments },
  });

  return { commitmentId: commitment.id, segments: created };
}

/** Mark one segment delivered. */
export async function fulfillSegment(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; segmentId: string },
) {
  const segment = await one<{ id: string; commitment_id: string; quantity: number }>(
    'SELECT * FROM fulfillment_segments WHERE id = $1 AND bakery_id = $2 FOR UPDATE',
    [input.segmentId, input.bakeryId],
    client,
  );
  if (!segment) throw notFound('Segment not found');
  await client.query("UPDATE fulfillment_segments SET status = 'FULFILLED' WHERE id = $1", [
    segment.id,
  ]);

  const remaining = await one<{ count: number }>(
    "SELECT count(*)::int AS count FROM fulfillment_segments WHERE commitment_id = $1 AND status = 'PLANNED'",
    [segment.commitment_id],
    client,
  );
  await client.query('UPDATE commitments SET status = $2 WHERE id = $1', [
    segment.commitment_id,
    (remaining?.count ?? 0) === 0 ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
  ]);

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'fulfillment.segment.delivered',
    entityType: 'fulfillment_segment',
    entityId: segment.id,
    actorUserId: input.actorUserId,
    payload: { quantity: segment.quantity, commitmentId: segment.commitment_id },
  });
  return { segmentId: segment.id };
}
