/**
 * Idempotent seed: the two test tenants, their users, catalogue and policies.
 *
 *   npm run seed
 *
 * Re-running is safe. It never deletes scenario data.
 */
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth.js';
import { config } from '../config.js';
import { closePool, one, withTx } from '../db.js';

export const BAKERY_A_SLUG = 'crust-and-crackle';
export const BAKERY_B_SLUG = 'second-bakery';

interface ProductSpec {
  sku: string;
  name: string;
  priceCents: number;
  policy: { soft: number; hard: number; overflow: number };
  recipe: { name: string; ingredients: Record<string, unknown> };
}

const PRODUCTS: ProductSpec[] = [
  {
    sku: 'COUNTRY-BLONDE',
    name: 'Country Blonde',
    priceCents: 1400,
    policy: { soft: 45, hard: 50, overflow: 3 },
    recipe: {
      name: 'Country Blonde Dough',
      ingredients: { flour_g: 1000, water_g: 720, salt_g: 20, levain_g: 200 },
    },
  },
  {
    sku: 'HEARTH-MICHE',
    name: 'Hearth Miche',
    priceCents: 950,
    policy: { soft: 100, hard: 120, overflow: 10 },
    recipe: {
      name: 'Hearth Miche Dough',
      ingredients: { flour_g: 1200, water_g: 900, salt_g: 24, levain_g: 240 },
    },
  },
  {
    sku: 'SOURDOUGH-ROLL',
    name: 'Sourdough Roll',
    priceCents: 100,
    policy: { soft: 400, hard: 500, overflow: 50 },
    recipe: {
      name: 'Sourdough Roll Dough',
      ingredients: { flour_g: 500, water_g: 340, salt_g: 10, levain_g: 100 },
    },
  },
  {
    // Used only by the historical-integrity scenario, which rewinds its own
    // price and recipe versions on each run.
    sku: 'HERITAGE-LOAF',
    name: 'Heritage Loaf',
    priceCents: 1400,
    policy: { soft: 40, hard: 50, overflow: 5 },
    recipe: {
      name: 'Heritage Loaf Dough',
      ingredients: { flour_g: 1000, water_g: 700, salt_g: 20, levain_g: 180, version_note: 'v1' },
    },
  },
];

const CUSTOMERS_A: { name: string; kind: 'RETAIL' | 'WHOLESALE' | 'CONSIGNMENT_PARTNER' }[] = [
  { name: 'Ada Rye', kind: 'RETAIL' },
  { name: 'Ben Oat', kind: 'RETAIL' },
  { name: 'Cleo Spelt', kind: 'RETAIL' },
  { name: 'Dov Kamut', kind: 'RETAIL' },
  { name: 'Esme Durum', kind: 'RETAIL' },
  { name: 'Northside Grocer', kind: 'WHOLESALE' },
  { name: 'Corner Cafe', kind: 'CONSIGNMENT_PARTNER' },
];

const CUSTOMERS_B: { name: string; kind: 'RETAIL' | 'WHOLESALE' | 'CONSIGNMENT_PARTNER' }[] = [
  { name: 'Bakery B Customer', kind: 'RETAIL' },
  { name: 'Bakery B Wholesale', kind: 'WHOLESALE' },
];

async function upsertBakery(client: PoolClient, slug: string, name: string): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO bakeries (slug, name) VALUES ($1,$2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, name],
    client,
  );
  return row!.id;
}

async function upsertUser(
  client: PoolClient,
  email: string,
  displayName: string,
  passwordHash: string,
): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash) VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name,
                                       password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [email, displayName, passwordHash],
    client,
  );
  return row!.id;
}

async function upsertMembership(
  client: PoolClient,
  userId: string,
  bakeryId: string,
  role: 'OWNER' | 'STAFF' | 'READONLY',
) {
  await client.query(
    `INSERT INTO memberships (user_id, bakery_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, bakery_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, bakeryId, role],
  );
}

async function upsertCatalogue(client: PoolClient, bakeryId: string) {
  for (const spec of PRODUCTS) {
    const product = await one<{ id: string }>(
      `INSERT INTO products (bakery_id, sku, name) VALUES ($1,$2,$3)
       ON CONFLICT (bakery_id, sku) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [bakeryId, spec.sku, spec.name],
      client,
    );
    const productId = product!.id;

    const hasPrice = await one('SELECT 1 FROM product_prices WHERE product_id = $1', [productId], client);
    if (!hasPrice) {
      await client.query(
        `INSERT INTO product_prices (bakery_id, product_id, version, unit_price_cents)
         VALUES ($1,$2,1,$3)`,
        [bakeryId, productId, spec.priceCents],
      );
    }

    await client.query(
      `INSERT INTO availability_policies
         (bakery_id, product_id, soft_threshold, hard_limit, overflow_allowance)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (product_id) DO UPDATE
         SET soft_threshold = EXCLUDED.soft_threshold,
             hard_limit = EXCLUDED.hard_limit,
             overflow_allowance = EXCLUDED.overflow_allowance`,
      [bakeryId, productId, spec.policy.soft, spec.policy.hard, spec.policy.overflow],
    );

    const recipe = await one<{ id: string }>(
      `INSERT INTO recipes (bakery_id, product_id, name) VALUES ($1,$2,$3)
       ON CONFLICT (bakery_id, product_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [bakeryId, productId, spec.recipe.name],
      client,
    );
    const hasVersion = await one('SELECT 1 FROM recipe_versions WHERE recipe_id = $1', [recipe!.id], client);
    if (!hasVersion) {
      await client.query(
        `INSERT INTO recipe_versions (bakery_id, recipe_id, version, ingredients, notes)
         VALUES ($1,$2,1,$3::jsonb,'Seeded original')`,
        [bakeryId, recipe!.id, JSON.stringify(spec.recipe.ingredients)],
      );
    }
  }
}

async function upsertCustomers(
  client: PoolClient,
  bakeryId: string,
  list: { name: string; kind: string }[],
) {
  for (const c of list) {
    await client.query(
      `INSERT INTO customers (bakery_id, name, kind) VALUES ($1,$2,$3)
       ON CONFLICT (bakery_id, name) DO NOTHING`,
      [bakeryId, c.name, c.kind],
    );
  }
}

export interface SeedResult {
  bakeryA: string;
  bakeryB: string;
  users: { email: string; role: string; bakery: string }[];
}

export async function seed(): Promise<SeedResult> {
  const passwordHash = await hashPassword(config.seedPassword);

  return withTx(async (client) => {
    const bakeryA = await upsertBakery(client, BAKERY_A_SLUG, 'Crust & Crackle Test Bakery');
    const bakeryB = await upsertBakery(client, BAKERY_B_SLUG, 'Second Bakery Test');

    const ownerA = await upsertUser(client, 'owner@crustandcrackle.test', 'Avery Crust (A owner)', passwordHash);
    const bakerA = await upsertUser(client, 'baker@crustandcrackle.test', 'Sam Crumb (A staff)', passwordHash);
    const ownerB = await upsertUser(client, 'owner@secondbakery.test', 'Robin Second (B owner)', passwordHash);

    await upsertMembership(client, ownerA, bakeryA, 'OWNER');
    await upsertMembership(client, bakerA, bakeryA, 'STAFF');
    await upsertMembership(client, ownerB, bakeryB, 'OWNER');

    await upsertCatalogue(client, bakeryA);
    await upsertCatalogue(client, bakeryB);
    await upsertCustomers(client, bakeryA, CUSTOMERS_A);
    await upsertCustomers(client, bakeryB, CUSTOMERS_B);

    await client.query(
      `INSERT INTO audit_log (bakery_id, actor_user_id, action, entity_type, outcome, after_state)
       VALUES ($1, NULL, 'platform.seed', 'bakery', 'ALLOWED', $2::jsonb)`,
      [bakeryA, JSON.stringify({ products: PRODUCTS.map((p) => p.sku) })],
    );

    return {
      bakeryA,
      bakeryB,
      users: [
        { email: 'owner@crustandcrackle.test', role: 'OWNER', bakery: 'Crust & Crackle Test Bakery' },
        { email: 'baker@crustandcrackle.test', role: 'STAFF', bakery: 'Crust & Crackle Test Bakery' },
        { email: 'owner@secondbakery.test', role: 'OWNER', bakery: 'Second Bakery Test' },
      ],
    };
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  try {
    const result = await seed();
    console.log('[seed] tenants ready');
    for (const u of result.users) {
      console.log(`[seed]   ${u.email}  (${u.role} of ${u.bakery})  password: ${config.seedPassword}`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
