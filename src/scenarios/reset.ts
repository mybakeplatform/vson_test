/**
 * Scenario reset.
 *
 * Each scenario owns a slice of data identified by a scenario tag and its own
 * service dates. Resetting clears that slice so the scenario can be re-run
 * from a known state.
 *
 * The events, audit_log and recommendations tables are NEVER cleared: the
 * history of what the platform did - including every recommendation and the
 * decision taken on it - is the point of the exercise. Clearing the
 * slice does require lifting the append-only guard on a few child tables, so
 * it happens under an explicit, transaction-scoped flag and is itself audited.
 */
import type { PoolClient } from 'pg';
import { writeAudit } from '../events.js';
import { DATES, SKU, type ScenarioKey } from './constants.js';
import { productIdBySku } from './refs.js';

/** Turn the history guard off for the remainder of THIS transaction only. */
export async function allowHistoryMutation(client: PoolClient, on: boolean) {
  await client.query("SELECT set_config('mybake.allow_history_mutation', $1, true)", [on ? 'on' : 'off']);
}

const SCENARIO_DATES: Record<ScenarioKey, { sku: string; dates: string[] }[]> = {
  availability: [{ sku: SKU.countryBlonde, dates: [DATES.availability] }],
  production: [{ sku: SKU.hearthMiche, dates: [DATES.production] }],
  failure: [{ sku: SKU.hearthMiche, dates: [DATES.failureDay1, DATES.failureDay2] }],
  payments: [{ sku: SKU.countryBlonde, dates: [DATES.payments] }],
  credit: [{ sku: SKU.sourdoughRoll, dates: [DATES.credit] }],
  shipping: [{ sku: SKU.countryBlonde, dates: [DATES.shippingFirst, DATES.shippingSecond] }],
  consignment: [{ sku: SKU.hearthMiche, dates: [DATES.consignment] }],
  history: [{ sku: SKU.heritageLoaf, dates: [DATES.history] }],
  tesla: [{ sku: SKU.hearthMiche, dates: [DATES.tesla] }],
};

export async function resetScenario(
  client: PoolClient,
  input: { bakeryId: string; actorUserId: string; scenario: ScenarioKey },
): Promise<void> {
  const { bakeryId, scenario } = input;
  await allowHistoryMutation(client, true);
  try {
    // Order matters: children that do not cascade from orders go first.
    await client.query('DELETE FROM payments WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);
    await client.query('DELETE FROM credits WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);
    await client.query('DELETE FROM wholesale_allocations WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);
    await client.query('DELETE FROM consignment_deliveries WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);
    await client.query('DELETE FROM production_plans WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);
    await client.query('DELETE FROM orders WHERE bakery_id = $1 AND scenario_tag = $2', [bakeryId, scenario]);

    for (const group of SCENARIO_DATES[scenario]) {
      const productId = await productIdBySku(client, bakeryId, group.sku);
      await client.query(
        'DELETE FROM availability_decisions WHERE bakery_id = $1 AND product_id = $2 AND service_date = ANY($3::date[])',
        [bakeryId, productId, group.dates],
      );
      await client.query(
        'DELETE FROM availability_days WHERE bakery_id = $1 AND product_id = $2 AND service_date = ANY($3::date[])',
        [bakeryId, productId, group.dates],
      );
      await client.query(
        'DELETE FROM production_demands WHERE bakery_id = $1 AND product_id = $2 AND service_date = ANY($3::date[])',
        [bakeryId, productId, group.dates],
      );
    }

    if (scenario === 'history') await rewindHeritageVersions(client, bakeryId);
  } finally {
    await allowHistoryMutation(client, false);
  }

  await writeAudit(client, {
    bakeryId,
    actorUserId: input.actorUserId,
    action: 'scenario.reset',
    entityType: 'scenario',
    afterState: { scenario },
  });
}

/**
 * The historical-integrity scenario walks a product from v1 to v2 on both
 * price and recipe. To be repeatable it needs to start at v1 again, so its
 * dedicated product (Heritage Loaf, used by no other scenario) is rewound.
 */
async function rewindHeritageVersions(client: PoolClient, bakeryId: string) {
  const productId = await productIdBySku(client, bakeryId, SKU.heritageLoaf);
  await client.query('DELETE FROM product_prices WHERE product_id = $1 AND version > 1', [productId]);
  await client.query(
    'UPDATE product_prices SET superseded_at = NULL WHERE product_id = $1 AND version = 1',
    [productId],
  );
  await client.query(
    `DELETE FROM recipe_versions
      WHERE version > 1 AND recipe_id IN (SELECT id FROM recipes WHERE product_id = $1)`,
    [productId],
  );
  await client.query(
    `UPDATE recipe_versions SET superseded_at = NULL
      WHERE version = 1 AND recipe_id IN (SELECT id FROM recipes WHERE product_id = $1)`,
    [productId],
  );
  await client.query(
    'UPDATE product_prices SET unit_price_cents = 1400 WHERE product_id = $1 AND version = 1',
    [productId],
  );
}
