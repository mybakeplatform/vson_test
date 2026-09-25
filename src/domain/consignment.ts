/**
 * Consignment.
 *
 * Deliver 10, expect 2 back, get 0 back: the system records a discrepancy and
 * stops. It does not decide that the missing 2 were sold, lost, or never
 * collected - a person does, and their choice is stored with their name on it.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

export const RESOLUTION_OPTIONS = [
  { code: 'ASSUME_SOLD', label: 'Assume Sold' },
  { code: 'BAKERY_MISSED_RETURN', label: 'Bakery Missed Return' },
  { code: 'WRITE_OFF_LOST', label: 'Write Off/Lost' },
  { code: 'OTHER', label: 'Other' },
] as const;

export type ResolutionCode = (typeof RESOLUTION_OPTIONS)[number]['code'];

export async function createDelivery(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    partnerId: string;
    productId: string;
    deliveredUnits: number;
    expectedReturnUnits: number;
    deliveredOn: string;
    scenarioTag?: string | null;
  },
) {
  const partner = await one<{ id: string }>(
    'SELECT id FROM customers WHERE id = $1 AND bakery_id = $2',
    [input.partnerId, input.bakeryId],
    client,
  );
  if (!partner) throw notFound('Consignment partner not found in this bakery');
  if (input.expectedReturnUnits > input.deliveredUnits) {
    throw unprocessable('BAD_EXPECTATION', 'Cannot expect more back than was delivered');
  }

  const delivery = await one<Record<string, unknown> & { id: string }>(
    `INSERT INTO consignment_deliveries
       (bakery_id, partner_id, product_id, delivered_units, expected_return_units, delivered_on, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.bakeryId,
      input.partnerId,
      input.productId,
      input.deliveredUnits,
      input.expectedReturnUnits,
      input.deliveredOn,
      input.scenarioTag ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'consignment.delivered',
    entityType: 'consignment_delivery',
    entityId: delivery!.id,
    actorUserId: input.actorUserId,
    payload: {
      deliveredUnits: input.deliveredUnits,
      expectedReturnUnits: input.expectedReturnUnits,
      partnerId: input.partnerId,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'consignment.deliver',
    entityType: 'consignment_delivery',
    entityId: delivery!.id,
    afterState: delivery,
  });
  return delivery!;
}

export async function recordReturn(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    deliveryId: string;
    returnedUnits: number;
    returnedOn: string;
  },
) {
  const delivery = await one<{
    id: string;
    delivered_units: number;
    expected_return_units: number;
    status: string;
  }>('SELECT * FROM consignment_deliveries WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.deliveryId,
    input.bakeryId,
  ], client);
  if (!delivery) throw notFound('Delivery not found');
  if (input.returnedUnits < 0 || input.returnedUnits > delivery.delivered_units) {
    throw unprocessable('BAD_RETURN', 'Returned units must be between 0 and what was delivered');
  }

  const ret = await one<{ id: string }>(
    `INSERT INTO consignment_returns (bakery_id, delivery_id, returned_units, returned_on, recorded_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.bakeryId, delivery.id, input.returnedUnits, input.returnedOn, input.actorUserId],
    client,
  );

  const delta = input.returnedUnits - delivery.expected_return_units;
  let discrepancyId: string | null = null;

  if (delta !== 0) {
    const discrepancy = await one<{ id: string }>(
      `INSERT INTO consignment_discrepancies
         (bakery_id, delivery_id, return_id, expected_units, actual_units, delta_units)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        input.bakeryId,
        delivery.id,
        ret!.id,
        delivery.expected_return_units,
        input.returnedUnits,
        delta,
      ],
      client,
    );
    discrepancyId = discrepancy!.id;
    await client.query("UPDATE consignment_deliveries SET status = 'DISCREPANCY' WHERE id = $1", [
      delivery.id,
    ]);
    await emitEvent(client, {
      bakeryId: input.bakeryId,
      type: 'consignment.discrepancy.opened',
      entityType: 'consignment_discrepancy',
      entityId: discrepancy!.id,
      actorUserId: input.actorUserId,
      payload: {
        deliveryId: delivery.id,
        expected: delivery.expected_return_units,
        actual: input.returnedUnits,
        delta,
        autoResolved: false,
        options: RESOLUTION_OPTIONS,
      },
    });
  } else {
    await client.query("UPDATE consignment_deliveries SET status = 'RECONCILED' WHERE id = $1", [
      delivery.id,
    ]);
    await emitEvent(client, {
      bakeryId: input.bakeryId,
      type: 'consignment.reconciled',
      entityType: 'consignment_delivery',
      entityId: delivery.id,
      actorUserId: input.actorUserId,
      payload: { returnedUnits: input.returnedUnits },
    });
  }

  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'consignment.return',
    entityType: 'consignment_return',
    entityId: ret!.id,
    afterState: {
      returnedUnits: input.returnedUnits,
      expected: delivery.expected_return_units,
      delta,
      discrepancyId,
    },
  });

  return {
    returnId: ret!.id,
    discrepancyId,
    delta,
    expected: delivery.expected_return_units,
    actual: input.returnedUnits,
    options: RESOLUTION_OPTIONS,
  };
}

export async function resolveDiscrepancy(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    discrepancyId: string;
    resolutionCode: ResolutionCode;
    note?: string | null;
  },
) {
  if (!RESOLUTION_OPTIONS.some((o) => o.code === input.resolutionCode)) {
    throw unprocessable('BAD_RESOLUTION', 'Unknown resolution code');
  }
  if (input.resolutionCode === 'OTHER' && !input.note?.trim()) {
    throw unprocessable('NOTE_REQUIRED', 'Resolution "Other" requires a note');
  }

  const discrepancy = await one<{
    id: string;
    delivery_id: string;
    status: string;
    expected_units: number;
    actual_units: number;
    delta_units: number;
  }>('SELECT * FROM consignment_discrepancies WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.discrepancyId,
    input.bakeryId,
  ], client);
  if (!discrepancy) throw notFound('Discrepancy not found');
  if (discrepancy.status === 'RESOLVED') throw conflict('That discrepancy is already resolved');

  await client.query(
    `UPDATE consignment_discrepancies
        SET status = 'RESOLVED', resolution_code = $2, resolution_note = $3,
            resolved_by = $4, resolved_at = now()
      WHERE id = $1`,
    [discrepancy.id, input.resolutionCode, input.note ?? null, input.actorUserId],
  );
  await client.query("UPDATE consignment_deliveries SET status = 'RECONCILED' WHERE id = $1", [
    discrepancy.delivery_id,
  ]);

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'consignment.discrepancy.resolved',
    entityType: 'consignment_discrepancy',
    entityId: discrepancy.id,
    actorUserId: input.actorUserId,
    payload: { resolutionCode: input.resolutionCode, note: input.note ?? null },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'consignment.discrepancy.resolve',
    entityType: 'consignment_discrepancy',
    entityId: discrepancy.id,
    beforeState: { status: 'OPEN', delta: discrepancy.delta_units },
    afterState: { status: 'RESOLVED', resolutionCode: input.resolutionCode, note: input.note ?? null },
  });

  return { discrepancyId: discrepancy.id, resolutionCode: input.resolutionCode };
}

export async function openDiscrepancies(client: PoolClient, bakeryId: string) {
  return query(
    `SELECT d.*, cd.delivered_units, cd.expected_return_units, c.name AS partner_name
       FROM consignment_discrepancies d
       JOIN consignment_deliveries cd ON cd.id = d.delivery_id
       JOIN customers c ON c.id = cd.partner_id
      WHERE d.bakery_id = $1 AND d.status = 'OPEN'
      ORDER BY d.created_at DESC`,
    [bakeryId],
    client,
  );
}
