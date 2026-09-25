/**
 * Bakery-controlled shipping queue.
 *
 * A door-to-door order starts with no date at all. The bakery picks one, and
 * may move it. Moving a date does not edit the old assignment: the October 1
 * row stays, marked SUPERSEDED, and the October 1 production demand is
 * superseded by a new October 2 demand that is open.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { notFound, unprocessable } from '../http/errors.js';
import * as availability from './availability.js';
import { createCommitment } from './orders.js';

export async function assignShippingDate(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    orderId: string;
    scheduledDate: string;
    reason?: string | null;
  },
) {
  const order = await one<{
    id: string;
    status: string;
    channel: string;
    scheduled_date: string | null;
    code: string;
  }>('SELECT * FROM orders WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.orderId,
    input.bakeryId,
  ], client);
  if (!order) throw notFound('Order not found');
  if (order.status === 'CANCELLED') throw unprocessable('ORDER_CANCELLED', 'That order is cancelled');
  if (order.scheduled_date === input.scheduledDate) {
    throw unprocessable('SAME_DATE', `Order is already scheduled for ${input.scheduledDate}`);
  }

  const previous = await one<{ id: string; scheduled_date: string; sequence: number }>(
    "SELECT id, scheduled_date, sequence FROM shipping_assignments WHERE order_id = $1 AND status = 'ACTIVE' FOR UPDATE",
    [order.id],
    client,
  );

  // Retire the previous assignment before writing the new one; the partial
  // unique index allows exactly one ACTIVE row per order.
  if (previous) {
    await client.query(
      "UPDATE shipping_assignments SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1",
      [previous.id],
    );
  }

  const seq = await one<{ next: number }>(
    'SELECT coalesce(max(sequence),0)+1 AS next FROM shipping_assignments WHERE order_id = $1',
    [order.id],
    client,
  );
  const assignment = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO shipping_assignments (bakery_id, order_id, sequence, scheduled_date, assigned_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.bakeryId, order.id, seq!.next, input.scheduledDate, input.actorUserId, input.reason ?? null],
    client,
  );
  if (previous) {
    await client.query('UPDATE shipping_assignments SET superseded_by = $2 WHERE id = $1', [
      previous.id,
      assignment!.id,
    ]);
  }

  // Move the demand. Old rows are superseded, never edited in place.
  const oldCommitments = await query<{
    id: string;
    product_id: string;
    service_date: string;
    quantity: number;
    order_line_id: string;
  }>(
    `SELECT id, product_id, service_date, quantity, order_line_id FROM commitments
      WHERE order_id = $1 AND status NOT IN ('RELEASED','FULFILLED')`,
    [order.id],
    client,
  );

  const supersededDemands: string[] = [];
  const newDemands: string[] = [];

  if (oldCommitments.length === 0) {
    // First scheduling: create demand for the chosen date.
    const lines = await query<{ id: string; product_id: string; quantity: number }>(
      'SELECT id, product_id, quantity FROM order_lines WHERE order_id = $1 ORDER BY created_at',
      [order.id],
      client,
    );
    for (const line of lines) {
      const decision = await availability.reserve(client, {
        bakeryId: input.bakeryId,
        productId: line.product_id,
        serviceDate: input.scheduledDate,
        quantity: line.quantity,
        actorUserId: input.actorUserId,
        orderId: order.id,
      });
      if (decision.outcome === 'REJECT') {
        throw unprocessable('NO_CAPACITY', decision.reason, { decision });
      }
      const created = await createCommitment(client, {
        bakeryId: input.bakeryId,
        orderId: order.id,
        orderLineId: line.id,
        productId: line.product_id,
        serviceDate: input.scheduledDate,
        quantity: line.quantity,
      });
      newDemands.push(created.demandId);
    }
  } else {
    for (const c of oldCommitments) {
      const decision = await availability.reserve(client, {
        bakeryId: input.bakeryId,
        productId: c.product_id,
        serviceDate: input.scheduledDate,
        quantity: c.quantity,
        actorUserId: input.actorUserId,
        orderId: order.id,
      });
      if (decision.outcome === 'REJECT') {
        throw unprocessable('NO_CAPACITY', decision.reason, { decision });
      }
      await availability.release(client, {
        bakeryId: input.bakeryId,
        productId: c.product_id,
        serviceDate: c.service_date,
        quantity: c.quantity,
        actorUserId: input.actorUserId,
        orderId: order.id,
        note: `Released: delivery moved from ${c.service_date} to ${input.scheduledDate}`,
      });
      await client.query(
        "UPDATE commitments SET status = 'RELEASED', released_at = now() WHERE id = $1",
        [c.id],
      );

      const created = await createCommitment(client, {
        bakeryId: input.bakeryId,
        orderId: order.id,
        orderLineId: c.order_line_id,
        productId: c.product_id,
        serviceDate: input.scheduledDate,
        quantity: c.quantity,
      });
      newDemands.push(created.demandId);

      const superseded = await query<{ id: string }>(
        `UPDATE production_demands
            SET status = 'SUPERSEDED', superseded_at = now(), superseded_by = $2
          WHERE commitment_id = $1 AND status = 'OPEN'
          RETURNING id`,
        [c.id, created.demandId],
        client,
      );
      supersededDemands.push(...superseded.map((r) => r.id));
    }
  }

  await client.query(
    "UPDATE orders SET scheduled_date = $2, status = 'SCHEDULED' WHERE id = $1",
    [order.id, input.scheduledDate],
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: previous ? 'shipping.rescheduled' : 'shipping.scheduled',
    entityType: 'order',
    entityId: order.id,
    actorUserId: input.actorUserId,
    payload: {
      from: previous?.scheduled_date ?? null,
      to: input.scheduledDate,
      assignmentSequence: seq!.next,
      supersededDemands: supersededDemands.length,
      newDemands: newDemands.length,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: previous ? 'shipping.reschedule' : 'shipping.schedule',
    entityType: 'shipping_assignment',
    entityId: assignment!.id,
    beforeState: previous
      ? { scheduledDate: previous.scheduled_date, status: 'ACTIVE' }
      : { scheduledDate: null, status: order.status },
    afterState: { scheduledDate: input.scheduledDate, status: 'ACTIVE' },
  });

  return {
    assignmentId: assignment!.id,
    sequence: seq!.next,
    previousDate: previous?.scheduled_date ?? null,
    scheduledDate: input.scheduledDate,
    supersededDemands,
    newDemands,
  };
}

export async function shippingHistory(client: PoolClient, orderId: string) {
  return query(
    `SELECT sequence, scheduled_date, status, reason, created_at, superseded_at
       FROM shipping_assignments WHERE order_id = $1 ORDER BY sequence`,
    [orderId],
    client,
  );
}
