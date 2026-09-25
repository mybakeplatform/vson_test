/**
 * Payment brain.
 *
 * What the machine is allowed to decide by itself: money that lands against a
 * known order, up to what that order is owed. Everything else becomes an open
 * exception with suggestions attached, and waits for a person.
 *
 * A payment is a first-class row. It does not need an order to exist.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';
import { financials, refreshOrderTotals } from './orders.js';

export interface RecordPaymentInput {
  bakeryId: string;
  actorUserId: string;
  amountCents: number;
  method: 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'OTHER';
  /** Optional: a payment may arrive with no order attached at all. */
  orderId?: string | null;
  customerId?: string | null;
  externalRef?: string | null;
  note?: string | null;
  scenarioTag?: string | null;
}

export interface PaymentOutcome {
  paymentId: string;
  amountCents: number;
  allocatedCents: number;
  unresolvedCents: number;
  status: string;
  exceptionId: string | null;
  exceptionKind: string | null;
  suggestions: { orderId: string | null; amountCents: number; confidence: number; rationale: string }[];
}

export async function recordPayment(
  client: PoolClient,
  input: RecordPaymentInput,
): Promise<PaymentOutcome> {
  if (input.amountCents <= 0) throw unprocessable('INVALID_AMOUNT', 'Payment must be positive');

  if (input.externalRef) {
    const dupe = await one<{ id: string }>(
      'SELECT id FROM payments WHERE bakery_id = $1 AND external_ref = $2',
      [input.bakeryId, input.externalRef],
      client,
    );
    if (dupe) {
      throw conflict('A payment with that external reference already exists', {
        paymentId: dupe.id,
        externalRef: input.externalRef,
      });
    }
  }

  let customerId = input.customerId ?? null;
  if (input.orderId) {
    const order = await one<{ id: string; customer_id: string }>(
      'SELECT id, customer_id FROM orders WHERE id = $1 AND bakery_id = $2',
      [input.orderId, input.bakeryId],
      client,
    );
    if (!order) throw notFound('Order not found in this bakery');
    customerId = customerId ?? order.customer_id;
  }

  const payment = await one<{ id: string }>(
    `INSERT INTO payments (bakery_id, customer_id, order_id, amount_cents, method, external_ref,
                           reference_note, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.bakeryId,
      customerId,
      input.orderId ?? null,
      input.amountCents,
      input.method,
      input.externalRef ?? null,
      input.note ?? null,
      input.scenarioTag ?? null,
    ],
    client,
  );

  const outcome = await match(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    paymentId: payment!.id,
  });

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'payment.recorded',
    entityType: 'payment',
    entityId: payment!.id,
    actorUserId: input.actorUserId,
    payload: {
      amountCents: input.amountCents,
      orderId: input.orderId ?? null,
      allocatedCents: outcome.allocatedCents,
      unresolvedCents: outcome.unresolvedCents,
      status: outcome.status,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'payment.record',
    entityType: 'payment',
    entityId: payment!.id,
    afterState: outcome,
  });

  return outcome;
}

/** The automatic half. Deliberately conservative. */
async function match(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; paymentId: string },
): Promise<PaymentOutcome> {
  const payment = await one<{
    id: string;
    order_id: string | null;
    customer_id: string | null;
    amount_cents: number;
  }>('SELECT id, order_id, customer_id, amount_cents FROM payments WHERE id = $1 FOR UPDATE', [
    input.paymentId,
  ], client);
  if (!payment) throw notFound('Payment not found');

  let allocated = 0;
  let exceptionId: string | null = null;
  let exceptionKind: string | null = null;
  const suggestions: PaymentOutcome['suggestions'] = [];

  if (payment.order_id) {
    const f = await financials(client, payment.order_id);
    const applicable = Math.max(0, Math.min(payment.amount_cents, f.outstanding_cents));
    if (applicable > 0) {
      await client.query(
        `INSERT INTO payment_allocations (bakery_id, payment_id, order_id, amount_cents, kind, created_by)
         VALUES ($1,$2,$3,$4,'AUTO_EXACT',$5)`,
        [input.bakeryId, payment.id, payment.order_id, applicable, input.actorUserId],
      );
      allocated = applicable;
      await refreshOrderTotals(client, payment.order_id);
    }
    const leftover = payment.amount_cents - allocated;
    if (leftover > 0) {
      // Money the system will not place on its own.
      const exception = await one<{ id: string }>(
        `INSERT INTO payment_exceptions (bakery_id, payment_id, order_id, kind, amount_cents)
         VALUES ($1,$2,$3,'OVERPAYMENT',$4) RETURNING id`,
        [input.bakeryId, payment.id, payment.order_id, leftover],
        client,
      );
      exceptionId = exception!.id;
      exceptionKind = 'OVERPAYMENT';
      for (const s of await buildSuggestions(client, {
        bakeryId: input.bakeryId,
        exceptionId: exception!.id,
        paymentId: payment.id,
        customerId: payment.customer_id,
        amountCents: leftover,
        excludeOrderId: payment.order_id,
      })) {
        suggestions.push(s);
      }
      await emitEvent(client, {
        bakeryId: input.bakeryId,
        type: 'payment.exception.opened',
        entityType: 'payment_exception',
        entityId: exception!.id,
        actorUserId: input.actorUserId,
        payload: { kind: 'OVERPAYMENT', amountCents: leftover, paymentId: payment.id },
      });
    }
  } else {
    const exception = await one<{ id: string }>(
      `INSERT INTO payment_exceptions (bakery_id, payment_id, kind, amount_cents)
       VALUES ($1,$2,'UNMATCHED',$3) RETURNING id`,
      [input.bakeryId, payment.id, payment.amount_cents],
      client,
    );
    exceptionId = exception!.id;
    exceptionKind = 'UNMATCHED';
    for (const s of await buildSuggestions(client, {
      bakeryId: input.bakeryId,
      exceptionId: exception!.id,
      paymentId: payment.id,
      customerId: payment.customer_id,
      amountCents: payment.amount_cents,
    })) {
      suggestions.push(s);
    }
    await emitEvent(client, {
      bakeryId: input.bakeryId,
      type: 'payment.exception.opened',
      entityType: 'payment_exception',
      entityId: exception!.id,
      actorUserId: input.actorUserId,
      payload: {
        kind: 'UNMATCHED',
        amountCents: payment.amount_cents,
        suggestionCount: suggestions.length,
        ordersCreated: 0,
      },
    });
  }

  const unresolved = payment.amount_cents - allocated;
  const status =
    unresolved === 0 ? 'APPLIED' : allocated > 0 ? 'NEEDS_REVIEW' : 'UNAPPLIED';
  await client.query('UPDATE payments SET status = $2 WHERE id = $1', [payment.id, status]);

  return {
    paymentId: payment.id,
    amountCents: payment.amount_cents,
    allocatedCents: allocated,
    unresolvedCents: unresolved,
    status,
    exceptionId,
    exceptionKind,
    suggestions,
  };
}

/**
 * Advisory only. Suggestions point at orders that already exist; the engine
 * never invents an order to make the money fit.
 */
async function buildSuggestions(
  client: PoolClient,
  input: {
    bakeryId: string;
    exceptionId: string;
    paymentId: string;
    customerId: string | null;
    amountCents: number;
    excludeOrderId?: string | null;
  },
) {
  const candidates = await query<{
    id: string;
    code: string;
    customer_id: string;
    customer_name: string;
    outstanding_cents: number;
  }>(
    `SELECT o.id, o.code, o.customer_id, c.name AS customer_name,
            (o.total_cents
              - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id), 0)
              - coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id), 0))::int
              AS outstanding_cents
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.bakery_id = $1
        AND o.status <> 'CANCELLED'
        AND ($2::uuid IS NULL OR o.id <> $2)
      ORDER BY o.created_at`,
    [input.bakeryId, input.excludeOrderId ?? null],
    client,
  );

  const scored = candidates
    .filter((c) => c.outstanding_cents > 0)
    .map((c) => {
      const sameCustomer = input.customerId !== null && c.customer_id === input.customerId;
      let confidence = 0.2;
      let rationale = `Order ${c.code} (${c.customer_name}) is owed ${money(c.outstanding_cents)}.`;
      if (c.outstanding_cents === input.amountCents) {
        confidence = sameCustomer ? 0.95 : 0.75;
        rationale = `Order ${c.code} (${c.customer_name}) is owed exactly ${money(c.outstanding_cents)}, matching this payment.`;
      } else if (c.outstanding_cents > input.amountCents) {
        confidence = sameCustomer ? 0.5 : 0.35;
        rationale = `Order ${c.code} (${c.customer_name}) is owed ${money(c.outstanding_cents)}; this payment would part-pay it.`;
      } else {
        confidence = sameCustomer ? 0.4 : 0.25;
        rationale = `Order ${c.code} (${c.customer_name}) is owed ${money(c.outstanding_cents)}; this payment would clear it and leave ${money(input.amountCents - c.outstanding_cents)} over.`;
      }
      return { order: c, confidence, rationale };
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const out: PaymentOutcome['suggestions'] = [];
  for (const s of scored) {
    const amount = Math.min(input.amountCents, s.order.outstanding_cents);
    await client.query(
      `INSERT INTO payment_suggestions
         (bakery_id, exception_id, payment_id, order_id, amount_cents, confidence, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.bakeryId,
        input.exceptionId,
        input.paymentId,
        s.order.id,
        amount,
        s.confidence,
        s.rationale,
      ],
    );
    out.push({
      orderId: s.order.id,
      amountCents: amount,
      confidence: s.confidence,
      rationale: s.rationale,
    });
  }
  return out;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export type ResolutionCode = 'APPLY_TO_ORDER' | 'ISSUE_CREDIT' | 'REFUND' | 'WRITE_OFF' | 'OTHER';

/** The human half. Nothing here happens without an explicit decision. */
export async function resolveException(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    exceptionId: string;
    resolutionCode: ResolutionCode;
    note?: string | null;
    orderId?: string | null;
  },
) {
  const exception = await one<{
    id: string;
    payment_id: string;
    amount_cents: number;
    status: string;
    kind: string;
  }>('SELECT * FROM payment_exceptions WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.exceptionId,
    input.bakeryId,
  ], client);
  if (!exception) throw notFound('Payment exception not found');
  if (exception.status === 'RESOLVED') throw conflict('This exception is already resolved');
  if (input.resolutionCode === 'OTHER' && !input.note?.trim()) {
    throw unprocessable('NOTE_REQUIRED', 'Resolution "OTHER" requires a note');
  }

  const payment = await one<{ id: string; customer_id: string | null; amount_cents: number }>(
    'SELECT id, customer_id, amount_cents FROM payments WHERE id = $1',
    [exception.payment_id],
    client,
  );

  if (input.resolutionCode === 'APPLY_TO_ORDER') {
    if (!input.orderId) throw unprocessable('ORDER_REQUIRED', 'Pick the order to apply this to');
    const target = await one<{ id: string }>(
      'SELECT id FROM orders WHERE id = $1 AND bakery_id = $2',
      [input.orderId, input.bakeryId],
      client,
    );
    if (!target) throw notFound('Order not found in this bakery');
    const f = await financials(client, input.orderId);
    const amount = Math.min(exception.amount_cents, f.outstanding_cents);
    if (amount <= 0) throw unprocessable('NOTHING_OWED', 'That order has nothing outstanding');
    await client.query(
      `INSERT INTO payment_allocations (bakery_id, payment_id, order_id, amount_cents, kind, created_by)
       VALUES ($1,$2,$3,$4,'HUMAN_APPLIED',$5)`,
      [input.bakeryId, exception.payment_id, input.orderId, amount, input.actorUserId],
    );
    await refreshOrderTotals(client, input.orderId);
  }

  if (input.resolutionCode === 'ISSUE_CREDIT') {
    if (!payment?.customer_id) {
      throw unprocessable('CUSTOMER_REQUIRED', 'This payment has no customer to credit');
    }
    await client.query(
      `INSERT INTO credits (bakery_id, customer_id, amount_cents, source, note, created_by)
       VALUES ($1,$2,$3,'OVERPAYMENT',$4,$5)`,
      [
        input.bakeryId,
        payment.customer_id,
        exception.amount_cents,
        input.note ?? `Credit from payment ${exception.payment_id}`,
        input.actorUserId,
      ],
    );
  }

  await client.query(
    `UPDATE payment_exceptions
        SET status = 'RESOLVED', resolution_code = $2, resolution_note = $3,
            resolved_by = $4, resolved_at = now()
      WHERE id = $1`,
    [exception.id, input.resolutionCode, input.note ?? null, input.actorUserId],
  );

  // Recompute the payment's own status from its allocations.
  const applied = await one<{ total: number }>(
    'SELECT coalesce(sum(amount_cents),0)::int AS total FROM payment_allocations WHERE payment_id = $1',
    [exception.payment_id],
    client,
  );
  const stillOpen = await one<{ count: number }>(
    "SELECT count(*)::int AS count FROM payment_exceptions WHERE payment_id = $1 AND status = 'OPEN'",
    [exception.payment_id],
    client,
  );
  const status =
    (stillOpen?.count ?? 0) > 0
      ? 'NEEDS_REVIEW'
      : (applied?.total ?? 0) >= (payment?.amount_cents ?? 0)
        ? 'APPLIED'
        : 'PARTIALLY_APPLIED';
  await client.query('UPDATE payments SET status = $2 WHERE id = $1', [exception.payment_id, status]);

  await client.query(
    `UPDATE payment_suggestions SET status = 'DISMISSED', decided_by = $2, decided_at = now()
      WHERE exception_id = $1 AND status = 'SUGGESTED'`,
    [exception.id, input.actorUserId],
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'payment.exception.resolved',
    entityType: 'payment_exception',
    entityId: exception.id,
    actorUserId: input.actorUserId,
    payload: { resolutionCode: input.resolutionCode, note: input.note ?? null, orderId: input.orderId ?? null },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'payment.exception.resolve',
    entityType: 'payment_exception',
    entityId: exception.id,
    beforeState: { status: 'OPEN', kind: exception.kind, amountCents: exception.amount_cents },
    afterState: { status: 'RESOLVED', resolutionCode: input.resolutionCode, note: input.note ?? null },
  });

  return { exceptionId: exception.id, paymentStatus: status };
}

/** Accept one suggestion: applies it and closes the exception. */
export async function acceptSuggestion(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; suggestionId: string; note?: string | null },
) {
  const suggestion = await one<{
    id: string;
    exception_id: string;
    order_id: string | null;
    status: string;
  }>('SELECT * FROM payment_suggestions WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.suggestionId,
    input.bakeryId,
  ], client);
  if (!suggestion) throw notFound('Suggestion not found');
  if (suggestion.status !== 'SUGGESTED') throw conflict('That suggestion was already decided');

  const result = await resolveException(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    exceptionId: suggestion.exception_id,
    resolutionCode: 'APPLY_TO_ORDER',
    orderId: suggestion.order_id,
    note: input.note ?? 'Accepted system suggestion',
  });

  await client.query(
    "UPDATE payment_suggestions SET status = 'ACCEPTED', decided_by = $2, decided_at = now() WHERE id = $1",
    [suggestion.id, input.actorUserId],
  );
  return result;
}
