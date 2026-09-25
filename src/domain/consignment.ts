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

/**
 * What each human choice MEANS for stock and money.
 *
 * `bucket` is the column the unreturned units land in; `earnsRevenue` says
 * whether the bakery may now recognise them as sold; `staysBakeryHeld` says
 * whether the bakery still counts them as its own consignment stock.
 *
 * These four rows are the whole reason the resolution codes are not
 * interchangeable. Nothing here runs until a person has chosen.
 */
const RESOLUTION_EFFECTS: Record<
  ResolutionCode,
  {
    bucket: 'units_sold' | 'units_owed_back' | 'units_written_off' | 'units_unaccounted';
    earnsRevenue: boolean;
    staysBakeryHeld: boolean;
    summary: string;
  }
> = {
  ASSUME_SOLD: {
    bucket: 'units_sold',
    earnsRevenue: true,
    staysBakeryHeld: false,
    summary: 'Treated as sold by the partner: revenue recognised, no longer bakery-held stock.',
  },
  BAKERY_MISSED_RETURN: {
    bucket: 'units_owed_back',
    earnsRevenue: false,
    staysBakeryHeld: true,
    summary: 'Not collected: still the bakery\'s stock, owed back by the partner. No revenue.',
  },
  WRITE_OFF_LOST: {
    bucket: 'units_written_off',
    earnsRevenue: false,
    staysBakeryHeld: false,
    summary: 'Written off as lost: removed from bakery-held stock, no revenue recognised.',
  },
  OTHER: {
    bucket: 'units_unaccounted',
    earnsRevenue: false,
    staysBakeryHeld: true,
    summary: 'Left unaccounted pending the note: stock position unchanged, no revenue.',
  },
};

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

  // The consequence of the choice, written as a NEW row. Nothing above this
  // line is rewritten: expected, actual and delta keep the values they were
  // observed with.
  const settlement = await settleDiscrepancy(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    discrepancy,
    resolutionCode: input.resolutionCode,
    note: input.note ?? null,
  });

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'consignment.discrepancy.resolved',
    entityType: 'consignment_discrepancy',
    entityId: discrepancy.id,
    actorUserId: input.actorUserId,
    payload: {
      resolutionCode: input.resolutionCode,
      note: input.note ?? null,
      effect: settlement.effect,
    },
  });
  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'consignment.settled',
    entityType: 'consignment_settlement',
    entityId: settlement.id,
    actorUserId: input.actorUserId,
    payload: settlement.effect,
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'consignment.discrepancy.resolve',
    entityType: 'consignment_discrepancy',
    entityId: discrepancy.id,
    beforeState: { status: 'OPEN', delta: discrepancy.delta_units },
    afterState: {
      status: 'RESOLVED',
      resolutionCode: input.resolutionCode,
      note: input.note ?? null,
      effect: settlement.effect,
    },
  });

  return {
    discrepancyId: discrepancy.id,
    resolutionCode: input.resolutionCode,
    settlementId: settlement.id,
    effect: settlement.effect,
  };
}

/**
 * Turn one human decision into its operational consequence.
 *
 * Only ever called from resolveDiscrepancy, i.e. only after a person has
 * chosen. The unreturned units land in exactly one bucket, priced with a
 * snapshot of the price version in force at the moment of the decision.
 */
async function settleDiscrepancy(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    discrepancy: { id: string; delivery_id: string; expected_units: number; actual_units: number };
    resolutionCode: ResolutionCode;
    note: string | null;
  },
) {
  const { discrepancy } = input;
  const unreturned = discrepancy.expected_units - discrepancy.actual_units;
  if (unreturned <= 0) {
    throw unprocessable(
      'NOTHING_TO_SETTLE',
      'This discrepancy is not a shortfall; there are no unreturned units to account for',
    );
  }

  const delivery = await one<{ product_id: string }>(
    'SELECT product_id FROM consignment_deliveries WHERE id = $1 AND bakery_id = $2',
    [discrepancy.delivery_id, input.bakeryId],
    client,
  );
  if (!delivery) throw notFound('Delivery not found');

  const price = await one<{ id: string; unit_price_cents: number }>(
    `SELECT id, unit_price_cents FROM product_prices
      WHERE product_id = $1 AND superseded_at IS NULL`,
    [delivery.product_id],
    client,
  );
  if (!price) throw notFound('No current price for the consigned product');

  const rule = RESOLUTION_EFFECTS[input.resolutionCode];
  const buckets = {
    units_sold: 0,
    units_owed_back: 0,
    units_written_off: 0,
    units_unaccounted: 0,
  };
  buckets[rule.bucket] = unreturned;

  const revenueCents = rule.earnsRevenue ? price.unit_price_cents * unreturned : 0;
  const heldBefore = unreturned;
  const heldAfter = rule.staysBakeryHeld ? unreturned : 0;

  const row = await one<{ id: string }>(
    `INSERT INTO consignment_settlements
       (bakery_id, delivery_id, discrepancy_id, product_id, resolution_code,
        units_unreturned, units_sold, units_owed_back, units_written_off, units_unaccounted,
        unit_price_cents, price_version_id, revenue_cents,
        bakery_held_units_before, bakery_held_units_after, decided_by, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      input.bakeryId,
      discrepancy.delivery_id,
      discrepancy.id,
      delivery.product_id,
      input.resolutionCode,
      unreturned,
      buckets.units_sold,
      buckets.units_owed_back,
      buckets.units_written_off,
      buckets.units_unaccounted,
      price.unit_price_cents,
      price.id,
      revenueCents,
      heldBefore,
      heldAfter,
      input.actorUserId,
      input.note,
    ],
    client,
  );

  return {
    id: row!.id,
    effect: {
      resolutionCode: input.resolutionCode,
      unitsUnreturned: unreturned,
      ...buckets,
      unitPriceCents: price.unit_price_cents,
      revenueCents,
      bakeryHeldUnitsBefore: heldBefore,
      bakeryHeldUnitsAfter: heldAfter,
      summary: rule.summary,
    },
  };
}

/** Settlements for a delivery - the consequences, next to the observations. */
export async function settlementsFor(client: PoolClient, bakeryId: string, deliveryId: string) {
  return query(
    `SELECT * FROM consignment_settlements
      WHERE bakery_id = $1 AND delivery_id = $2 ORDER BY created_at, id`,
    [bakeryId, deliveryId],
    client,
  );
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
