/**
 * Full data reset: empties every table and re-seeds the two tenants.
 *
 *   npm run db:reset
 *
 * This DELETES the event and audit history, which normal application paths
 * cannot do. It exists for local development and for restoring a demo
 * environment to a known state - never point it at anything you care about.
 * Requires RESET_CONFIRM=yes.
 */
import { fileURLToPath } from 'node:url';
import { closePool, withTx } from '../db.js';
import { seed } from './seed.js';

const TABLES = [
  'realtime_receipts',
  'realtime_probes',
  'platform_probes',
  'scenario_runs',
  'idempotency_keys',
  'recommendation_effects',
  'recommendations',
  'wholesale_allocations',
  'consignment_discrepancies',
  'consignment_returns',
  'consignment_deliveries',
  'shipping_assignments',
  'credit_allocations',
  'credits',
  'payment_suggestions',
  'payment_exceptions',
  'payment_allocations',
  'payments',
  'production_failure_impacts',
  'fulfillment_segments',
  'surplus_inventory',
  'production_allocations',
  'production_runs',
  'mixer_loads',
  'production_plans',
  'production_demands',
  'commitments',
  'availability_decisions',
  'availability_days',
  'availability_policies',
  'order_lines',
  'orders',
  'customers',
  'recipe_versions',
  'recipes',
  'product_prices',
  'products',
  'audit_log',
  'events',
  'sessions',
  'memberships',
  'users',
  'bakeries',
];

export async function resetAll(): Promise<void> {
  await withTx(async (client) => {
    await client.query("SELECT set_config('mybake.allow_history_mutation', 'on', true)");
    await client.query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  if (process.env.RESET_CONFIRM !== 'yes') {
    console.error(
      'Refusing to wipe the database. Re-run with RESET_CONFIRM=yes if you really mean it.',
    );
    process.exit(1);
  }
  try {
    await resetAll();
    console.log('[reset] all tables emptied');
    await seed();
    console.log('[reset] tenants re-seeded');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
