/**
 * Customer credit.
 *
 * A credit is a pot of money that gets spent across several orders. Every
 * draw is an immutable row, so the allocation history survives: $30 spent as
 * $12 + $15 + $3 leaves $0, and the $20 order it partly paid still shows $17
 * outstanding.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { notFound, unprocessable } from '../http/errors.js';
import { financials, refreshOrderTotals } from './orders.js';

export async function issueCredit(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    customerId: string;
    amountCents: number;
    source: 'GOODWILL' | 'OVERPAYMENT' | 'RETURN' | 'MANUAL';
    note?: string | null;
    scenarioTag?: string | null;
  },
) {
  if (input.amountCents <= 0) throw unprocessable('INVALID_AMOUNT', 'Credit must be positive');
  const customer = await one<{ id: string }>(
    'SELECT id FROM customers WHERE id = $1 AND bakery_id = $2',
    [input.customerId, input.bakeryId],
    client,
  );
  if (!customer) throw notFound('Customer not found in this bakery');

  const credit = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO credits (bakery_id, customer_id, amount_cents, source, note, created_by, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.bakeryId,
      input.customerId,
      input.amountCents,
      input.source,
      input.note ?? null,
      input.actorUserId,
      input.scenarioTag ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'credit.issued',
    entityType: 'credit',
    entityId: credit!.id,
    actorUserId: input.actorUserId,
    payload: { customerId: input.customerId, amountCents: input.amountCents, source: input.source },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'credit.issue',
    entityType: 'credit',
    entityId: credit!.id,
    afterState: { amountCents: input.amountCents, source: input.source },
  });
  return credit!;
}

export async function creditBalance(client: PoolClient, creditId: string) {
  const row = await one<{ amount_cents: number; allocated_cents: number; remaining_cents: number }>(
    `SELECT c.amount_cents,
            coalesce((SELECT sum(amount_cents) FROM credit_allocations WHERE credit_id = c.id),0)::int AS allocated_cents,
            (c.amount_cents - coalesce((SELECT sum(amount_cents) FROM credit_allocations WHERE credit_id = c.id),0))::int AS remaining_cents
       FROM credits c WHERE c.id = $1`,
    [creditId],
    client,
  );
  if (!row) throw notFound('Credit not found');
  return row;
}

/**
 * Draw against a credit. Refuses to overspend the credit or to overpay the
 * order; both are server-side rules, not UI guesses.
 */
export async function applyCredit(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    creditId: string;
    orderId: string;
    amountCents: number;
  },
) {
  const credit = await one<{ id: string; customer_id: string; amount_cents: number }>(
    'SELECT id, customer_id, amount_cents FROM credits WHERE id = $1 AND bakery_id = $2 FOR UPDATE',
    [input.creditId, input.bakeryId],
    client,
  );
  if (!credit) throw notFound('Credit not found');

  const order = await one<{ id: string; customer_id: string; status: string }>(
    'SELECT id, customer_id, status FROM orders WHERE id = $1 AND bakery_id = $2 FOR UPDATE',
    [input.orderId, input.bakeryId],
    client,
  );
  if (!order) throw notFound('Order not found');
  if (order.customer_id !== credit.customer_id) {
    throw unprocessable('CUSTOMER_MISMATCH', 'That credit belongs to a different customer');
  }

  const balance = await creditBalance(client, credit.id);
  if (input.amountCents <= 0) throw unprocessable('INVALID_AMOUNT', 'Amount must be positive');
  if (input.amountCents > balance.remaining_cents) {
    throw unprocessable(
      'INSUFFICIENT_CREDIT',
      `Credit has ${balance.remaining_cents} cents left; ${input.amountCents} requested`,
    );
  }
  const f = await financials(client, order.id);
  if (input.amountCents > f.outstanding_cents) {
    throw unprocessable(
      'OVERPAYS_ORDER',
      `Order has ${f.outstanding_cents} cents outstanding; ${input.amountCents} requested`,
    );
  }

  const seq = await one<{ next: number }>(
    'SELECT coalesce(max(sequence),0)+1 AS next FROM credit_allocations WHERE credit_id = $1',
    [credit.id],
    client,
  );
  const allocation = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO credit_allocations (bakery_id, credit_id, order_id, amount_cents, sequence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.bakeryId, credit.id, order.id, input.amountCents, seq!.next, input.actorUserId],
    client,
  );

  const after = await refreshOrderTotals(client, order.id);
  const remaining = await creditBalance(client, credit.id);

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'credit.applied',
    entityType: 'credit',
    entityId: credit.id,
    actorUserId: input.actorUserId,
    payload: {
      orderId: order.id,
      amountCents: input.amountCents,
      sequence: seq!.next,
      creditRemainingCents: remaining.remaining_cents,
      orderOutstandingCents: after.outstanding_cents,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'credit.apply',
    entityType: 'credit_allocation',
    entityId: allocation!.id,
    beforeState: { creditRemainingCents: balance.remaining_cents, orderOutstandingCents: f.outstanding_cents },
    afterState: {
      creditRemainingCents: remaining.remaining_cents,
      orderOutstandingCents: after.outstanding_cents,
    },
  });

  return {
    allocationId: allocation!.id,
    sequence: seq!.next,
    creditRemainingCents: remaining.remaining_cents,
    orderOutstandingCents: after.outstanding_cents,
  };
}

export async function creditHistory(client: PoolClient, creditId: string) {
  return query(
    `SELECT ca.sequence, ca.amount_cents, ca.created_at, o.code AS order_code, o.total_cents,
            (o.total_cents
              - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id),0)
              - coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id),0))::int AS order_outstanding_cents
       FROM credit_allocations ca
       JOIN orders o ON o.id = ca.order_id
      WHERE ca.credit_id = $1
      ORDER BY ca.sequence`,
    [creditId],
    client,
  );
}
