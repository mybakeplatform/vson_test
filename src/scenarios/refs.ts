import type { PoolClient } from 'pg';
import { one } from '../db.js';
import { notFound } from '../http/errors.js';

export async function productIdBySku(
  client: PoolClient,
  bakeryId: string,
  sku: string,
): Promise<string> {
  const row = await one<{ id: string }>(
    'SELECT id FROM products WHERE bakery_id = $1 AND sku = $2',
    [bakeryId, sku],
    client,
  );
  if (!row) throw notFound(`Product ${sku} is not seeded for this bakery. Run: npm run seed`);
  return row.id;
}

export async function customerIdByName(
  client: PoolClient,
  bakeryId: string,
  name: string,
): Promise<string> {
  const row = await one<{ id: string }>(
    'SELECT id FROM customers WHERE bakery_id = $1 AND name = $2',
    [bakeryId, name],
    client,
  );
  if (!row) throw notFound(`Customer "${name}" is not seeded for this bakery. Run: npm run seed`);
  return row.id;
}

export async function recipeIdForProduct(client: PoolClient, productId: string): Promise<string> {
  const row = await one<{ id: string }>('SELECT id FROM recipes WHERE product_id = $1', [productId], client);
  if (!row) throw notFound('No recipe for that product. Run: npm run seed');
  return row.id;
}
