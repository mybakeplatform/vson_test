/**
 * Recommendation engine ("Tesla brain").
 *
 * It notices that 62 loaves cannot cover 60 customer units plus 5 wholesale,
 * and says so. It does not move the wholesale allocation. A person accepts or
 * rejects, and either way the recommendation and its outcome are kept.
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { conflict, notFound, unprocessable } from '../http/errors.js';

export async function setWholesaleAllocation(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    productId: string;
    serviceDate: string;
    units: number;
    sourceRecommendationId?: string | null;
    scenarioTag?: string | null;
  },
) {
  const current = await one<{ id: string; version: number; allocated_units: number }>(
    `SELECT id, version, allocated_units FROM wholesale_allocations
      WHERE product_id = $1 AND service_date = $2 AND status = 'ACTIVE' FOR UPDATE`,
    [input.productId, input.serviceDate],
    client,
  );

  if (current) {
    await client.query(
      "UPDATE wholesale_allocations SET status = 'SUPERSEDED', superseded_at = now() WHERE id = $1",
      [current.id],
    );
  }

  const next = await one<Record<string, unknown> & { id: string; version: number }>(
    `INSERT INTO wholesale_allocations
       (bakery_id, product_id, service_date, allocated_units, version, source_recommendation_id, scenario_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      input.units,
      (current?.version ?? 0) + 1,
      input.sourceRecommendationId ?? null,
      input.scenarioTag ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'wholesale.allocation.set',
    entityType: 'wholesale_allocation',
    entityId: next!.id,
    actorUserId: input.actorUserId,
    payload: {
      fromUnits: current?.allocated_units ?? null,
      toUnits: input.units,
      version: next!.version,
      serviceDate: input.serviceDate,
    },
  });
  return { allocation: next!, previous: current };
}

export interface SupplyEvaluation {
  customerDemand: number;
  wholesaleDemand: number;
  totalDemand: number;
  actualProduction: number;
  shortUnits: number;
  recommendationId: string | null;
  message: string | null;
}

/**
 * Compare demand against what was actually produced and, if customer orders
 * are at risk, raise a PENDING recommendation. Nothing is applied here.
 */
export async function evaluateSupply(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    productId: string;
    serviceDate: string;
    actualProduction: number;
    /** Override the derived customer demand (used by the scenario runner). */
    customerDemand?: number;
    scenarioTag?: string | null;
  },
): Promise<SupplyEvaluation> {
  const derived = await one<{ total: number }>(
    `SELECT coalesce(sum(quantity),0)::int AS total FROM production_demands
      WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3
        AND source = 'CUSTOMER' AND status = 'OPEN'`,
    [input.bakeryId, input.productId, input.serviceDate],
    client,
  );
  const customerDemand = input.customerDemand ?? derived!.total;

  const wholesale = await one<{ id: string; allocated_units: number }>(
    `SELECT id, allocated_units FROM wholesale_allocations
      WHERE product_id = $1 AND service_date = $2 AND status = 'ACTIVE'`,
    [input.productId, input.serviceDate],
    client,
  );
  const wholesaleDemand = wholesale?.allocated_units ?? 0;
  const totalDemand = customerDemand + wholesaleDemand;
  const shortUnits = Math.max(0, totalDemand - input.actualProduction);

  if (shortUnits === 0) {
    return {
      customerDemand,
      wholesaleDemand,
      totalDemand,
      actualProduction: input.actualProduction,
      shortUnits: 0,
      recommendationId: null,
      message: null,
    };
  }

  const reducible = Math.min(shortUnits, wholesaleDemand);
  const message =
    reducible > 0
      ? `${shortUnits} units short. Reducing wholesale allocation by ${reducible} would preserve customer orders.`
      : `${shortUnits} units short. There is no wholesale allocation left to reduce; customer orders are exposed.`;

  const recommendation = await one<{ id: string }>(
    `INSERT INTO recommendations (bakery_id, kind, product_id, service_date, message, payload, scenario_tag)
     VALUES ($1,'SUPPLY_SHORTFALL',$2,$3,$4,$5::jsonb,$6) RETURNING id`,
    [
      input.bakeryId,
      input.productId,
      input.serviceDate,
      message,
      JSON.stringify({
        customerDemand,
        wholesaleDemand,
        totalDemand,
        actualProduction: input.actualProduction,
        shortUnits,
        proposedWholesaleUnits: wholesaleDemand - reducible,
        reduceBy: reducible,
        autoApplied: false,
      }),
      input.scenarioTag ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'recommendation.raised',
    entityType: 'recommendation',
    entityId: recommendation!.id,
    actorUserId: input.actorUserId,
    payload: { message, shortUnits, autoApplied: false },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'recommendation.raise',
    entityType: 'recommendation',
    entityId: recommendation!.id,
    afterState: { message, status: 'PENDING' },
  });

  return {
    customerDemand,
    wholesaleDemand,
    totalDemand,
    actualProduction: input.actualProduction,
    shortUnits,
    recommendationId: recommendation!.id,
    message,
  };
}

export async function decide(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    recommendationId: string;
    decision: 'ACCEPT' | 'REJECT';
    note?: string | null;
  },
) {
  const rec = await one<{
    id: string;
    status: string;
    product_id: string | null;
    service_date: string | null;
    scenario_tag: string | null;
    payload: {
      proposedWholesaleUnits?: number;
      wholesaleDemand?: number;
      reduceBy?: number;
    };
  }>('SELECT * FROM recommendations WHERE id = $1 AND bakery_id = $2 FOR UPDATE', [
    input.recommendationId,
    input.bakeryId,
  ], client);
  if (!rec) throw notFound('Recommendation not found');
  if (rec.status !== 'PENDING') throw conflict(`That recommendation is already ${rec.status}`);

  const before = await one<{ allocated_units: number; version: number }>(
    `SELECT allocated_units, version FROM wholesale_allocations
      WHERE product_id = $1 AND service_date = $2 AND status = 'ACTIVE'`,
    [rec.product_id, rec.service_date],
    client,
  );

  let after = before;
  if (input.decision === 'ACCEPT') {
    const target = rec.payload.proposedWholesaleUnits;
    if (target === undefined || rec.product_id === null || rec.service_date === null) {
      throw unprocessable('NOT_APPLICABLE', 'This recommendation carries no applicable change');
    }
    const applied = await setWholesaleAllocation(client, {
      bakeryId: input.bakeryId,
      actorUserId: input.actorUserId,
      productId: rec.product_id,
      serviceDate: rec.service_date,
      units: target,
      sourceRecommendationId: rec.id,
      scenarioTag: rec.scenario_tag,
    });
    after = {
      allocated_units: applied.allocation.allocated_units as number,
      version: applied.allocation.version,
    };
  }

  await client.query(
    `UPDATE recommendations
        SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
      WHERE id = $1`,
    [rec.id, input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED', input.actorUserId, input.note ?? null],
  );

  await client.query(
    `INSERT INTO recommendation_effects
       (bakery_id, recommendation_id, entity_type, entity_id, before_state, after_state)
     VALUES ($1,$2,'wholesale_allocation',NULL,$3::jsonb,$4::jsonb)`,
    [
      input.bakeryId,
      rec.id,
      JSON.stringify(before ?? null),
      JSON.stringify(input.decision === 'ACCEPT' ? after : before ?? null),
    ],
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: input.decision === 'ACCEPT' ? 'recommendation.accepted' : 'recommendation.rejected',
    entityType: 'recommendation',
    entityId: rec.id,
    actorUserId: input.actorUserId,
    payload: {
      decision: input.decision,
      note: input.note ?? null,
      wholesaleBefore: before?.allocated_units ?? null,
      wholesaleAfter: after?.allocated_units ?? null,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: `recommendation.${input.decision.toLowerCase()}`,
    entityType: 'recommendation',
    entityId: rec.id,
    beforeState: { status: 'PENDING', wholesale: before },
    afterState: {
      status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
      wholesale: after,
      note: input.note ?? null,
    },
  });

  return {
    recommendationId: rec.id,
    decision: input.decision,
    wholesaleBefore: before?.allocated_units ?? null,
    wholesaleAfter: after?.allocated_units ?? null,
  };
}

export async function history(client: PoolClient, bakeryId: string) {
  return query(
    `SELECT r.id, r.kind, r.message, r.status, r.payload, r.created_at, r.decided_at,
            r.decision_note, u.display_name AS decided_by_name,
            (SELECT json_agg(json_build_object('before', e.before_state, 'after', e.after_state, 'at', e.created_at)
                             ORDER BY e.created_at)
               FROM recommendation_effects e WHERE e.recommendation_id = r.id) AS effects
       FROM recommendations r
       LEFT JOIN users u ON u.id = r.decided_by
      WHERE r.bakery_id = $1
      ORDER BY r.created_at DESC`,
    [bakeryId],
    client,
  );
}
