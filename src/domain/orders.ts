/**
 * Orders, commitments and demand.
 *
 * An order line snapshots the price version in force at the time it is
 * written. Nothing later rewrites it - see checks/historical integrity.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { notFound, unprocessable } from '../http/errors.js';
import * as availability from './availability.js';

export interface LineInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  bakeryId: string;
  actorUserId: string;
  customerId: string;
  channel: 'PICKUP' | 'DOOR_TO_DOOR' | 'WHOLESALE' | 'CONSIGNMENT';
  /** null means "the customer has not chosen a date" - see shipping queue. */
  serviceDate: string | null;
  lines: LineInput[];
  code?: string;
  scenarioTag?: string | null;
  requestedDate?: string | null;
}

export interface CreateOrderResult {
  accepted: boolean;
  order?: Record<string, unknown>;
  decisions: availability.AvailabilityDecision[];
  rejection?: availability.AvailabilityDecision;
}

async function currentPrice(client: PoolClient, productId: string) {
  const price = await one<{ id: string; unit_price_cents: number; version: number }>(
    `SELECT id, unit_price_cents, version FROM product_prices
      WHERE product_id = $1 AND superseded_at IS NULL`,
    [productId],
    client,
  );
  if (!price) throw notFound(`No current price for product ${productId}`);
  return price;
}

export function generateOrderCode(prefix = 'ORD'): string {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export async function createOrder(
  client: PoolClient,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  if (input.lines.length === 0) throw unprocessable('EMPTY_ORDER', 'An order needs at least one line');

  const customer = await one<{ id: string; bakery_id: string; name: string }>(
    'SELECT id, bakery_id, name FROM customers WHERE id = $1 AND bakery_id = $2',
    [input.customerId, input.bakeryId],
    client,
  );
  if (!customer) throw notFound('Customer not found in this bakery');

  const needsScheduling = input.serviceDate === null;
  if (needsScheduling && input.channel !== 'DOOR_TO_DOOR') {
    throw unprocessable('DATE_REQUIRED', 'Only door-to-door orders may start without a date');
  }

  // Capacity first: all-or-nothing across the whole order.
  const decisions: availability.AvailabilityDecision[] = [];
  if (!needsScheduling) {
    const grouped = new Map<string, number>();
    for (const line of input.lines) {
      grouped.set(line.productId, (grouped.get(line.productId) ?? 0) + line.quantity);
    }
    for (const [productId, quantity] of grouped) {
      const decision = await availability.reserve(client, {
        bakeryId: input.bakeryId,
        productId,
        serviceDate: input.serviceDate!,
        quantity,
        actorUserId: input.actorUserId,
      });
      decisions.push(decision);
      if (decision.outcome === 'REJECT') {
        // Hand back anything already taken for this order, then stop. The
        // REJECT row stays committed as evidence; no order is written.
        for (const prior of decisions.filter((d) => d.outcome === 'ACCEPT')) {
          await availability.release(client, {
            bakeryId: input.bakeryId,
            productId: prior.policy.product_id,
            serviceDate: input.serviceDate!,
            quantity: prior.requestedUnits,
            actorUserId: input.actorUserId,
            note: 'Released: another line of the same order was rejected (no partial acceptance)',
          });
        }
        return { accepted: false, decisions, rejection: decision };
      }
    }
  }

  const status = needsScheduling ? 'AWAITING_SCHEDULING' : 'OPEN';
  const order = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO orders (bakery_id, customer_id, code, channel, status, scheduled_date,
                         requested_date, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      input.bakeryId,
      input.customerId,
      input.code ?? generateOrderCode(),
      input.channel,
      status,
      input.serviceDate,
      input.requestedDate ?? null,
      input.scenarioTag ?? null,
    ],
    client,
  );

  let total = 0;
  for (const line of input.lines) {
    const price = await currentPrice(client, line.productId);
    const lineTotal = price.unit_price_cents * line.quantity;
    total += lineTotal;
    const orderLine = await one<{ id: string }>(
      `INSERT INTO order_lines
         (bakery_id, order_id, product_id, quantity, unit_price_cents, price_version_id, line_total_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        input.bakeryId,
        order!.id,
        line.productId,
        line.quantity,
        price.unit_price_cents,
        price.id,
        lineTotal,
      ],
      client,
    );

    if (!needsScheduling) {
      await createCommitment(client, {
        bakeryId: input.bakeryId,
        orderId: order!.id,
        orderLineId: orderLine!.id,
        productId: line.productId,
        serviceDate: input.serviceDate!,
        quantity: line.quantity,
      });
    }
  }

  await client.query('UPDATE orders SET total_cents = $2 WHERE id = $1', [order!.id, total]);
  order!.total_cents = total;

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'order.created',
    entityType: 'order',
    entityId: order!.id,
    actorUserId: input.actorUserId,
    payload: { code: order!.code, status, totalCents: total, serviceDate: input.serviceDate },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'order.create',
    entityType: 'order',
    entityId: order!.id,
    afterState: { code: order!.code, status, totalCents: total, lines: input.lines },
  });

  return { accepted: true, order: order!, decisions };
}

/** A commitment plus the matching production demand row. */
export async function createCommitment(
  client: PoolClient,
  input: {
    bakeryId: string;
    orderId: string;
    orderLineId: string;
    productId: string;
    serviceDate: string;
    quantity: number;
  },
): Promise<{ commitmentId: string; demandId: string }> {
  const commitment = await one<{ id: string }>(
    `INSERT INTO commitments (bakery_id, order_id, order_line_id, product_id, service_date, quantity)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.bakeryId,
      input.orderId,
      input.orderLineId,
      input.productId,
      input.serviceDate,
      input.quantity,
    ],
    client,
  );
  const demand = await one<{ id: string }>(
    `INSERT INTO production_demands
       (bakery_id, product_id, service_date, quantity, source, order_id, commitment_id)
     VALUES ($1,$2,$3,$4,'CUSTOMER',$5,$6) RETURNING id`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      input.quantity,
      input.orderId,
      commitment!.id,
    ],
    client,
  );
  return { commitmentId: commitment!.id, demandId: demand!.id };
}

/** Cancel an order and hand its capacity back. */
export async function cancelOrder(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; orderId: string; reason: string },
) {
  const order = await one<{ id: string; status: string; code: string }>(
    'SELECT id, status, code FROM orders WHERE id = $1 AND bakery_id = $2 FOR UPDATE',
    [input.orderId, input.bakeryId],
    client,
  );
  if (!order) throw notFound('Order not found');

  const commitments = await query<{
    id: string;
    product_id: string;
    service_date: string;
    quantity: number;
  }>(
    `SELECT id, product_id, service_date, quantity FROM commitments
      WHERE order_id = $1 AND status <> 'RELEASED'`,
    [input.orderId],
    client,
  );
  for (const c of commitments) {
    await availability.release(client, {
      bakeryId: input.bakeryId,
      productId: c.product_id,
      serviceDate: c.service_date,
      quantity: c.quantity,
      actorUserId: input.actorUserId,
      orderId: input.orderId,
      note: `Released by order cancellation: ${input.reason}`,
    });
    await client.query(
      "UPDATE commitments SET status = 'RELEASED', released_at = now() WHERE id = $1",
      [c.id],
    );
  }
  await client.query(
    "UPDATE production_demands SET status = 'CANCELLED' WHERE order_id = $1 AND status = 'OPEN'",
    [input.orderId],
  );
  await client.query("UPDATE orders SET status = 'CANCELLED' WHERE id = $1", [input.orderId]);

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'order.cancelled',
    entityType: 'order',
    entityId: input.orderId,
    actorUserId: input.actorUserId,
    payload: { reason: input.reason, releasedCommitments: commitments.length },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'order.cancel',
    entityType: 'order',
    entityId: input.orderId,
    beforeState: { status: order.status },
    afterState: { status: 'CANCELLED', reason: input.reason },
  });
  return { cancelled: commitments.length };
}

/** total / paid / credit / outstanding, recomputed from allocation rows. */
export async function financials(client: PoolClient, orderId: string) {
  const row = await one<{
    total_cents: number;
    paid_cents: number;
    credit_cents: number;
    outstanding_cents: number;
  }>(
    `SELECT o.total_cents,
            coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id), 0)::int AS paid_cents,
            coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id), 0)::int AS credit_cents,
            (o.total_cents
              - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id), 0)
              - coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id), 0))::int AS outstanding_cents
       FROM orders o WHERE o.id = $1`,
    [orderId],
    client,
  );
  if (!row) throw notFound('Order not found');
  return row;
}

/** Keep the denormalised columns on orders in step with the ledgers. */
export async function refreshOrderTotals(client: PoolClient, orderId: string) {
  const f = await financials(client, orderId);
  await client.query('UPDATE orders SET paid_cents = $2, credit_cents = $3 WHERE id = $1', [
    orderId,
    f.paid_cents,
    f.credit_cents,
  ]);
  return f;
}
