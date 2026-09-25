/**
 * Catalogue changes that must not reach backwards.
 *
 * Raising the price of Country Blonde from $14 to $15 creates version 2. It
 * does not touch version 1, and it cannot touch the order line that captured
 * version 1 - the database refuses that write (see the triggers in 001_init).
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { emitEvent, writeAudit } from '../events.js';
import { notFound } from '../http/errors.js';

export async function changePrice(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    productId: string;
    unitPriceCents: number;
  },
) {
  const current = await one<{ id: string; version: number; unit_price_cents: number }>(
    `SELECT id, version, unit_price_cents FROM product_prices
      WHERE product_id = $1 AND superseded_at IS NULL FOR UPDATE`,
    [input.productId],
    client,
  );
  if (!current) throw notFound('Product has no current price');

  await client.query('UPDATE product_prices SET superseded_at = now() WHERE id = $1', [current.id]);
  const next = await one<Record<string, unknown> & { id: string; version: number }>(
    `INSERT INTO product_prices (bakery_id, product_id, version, unit_price_cents)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [input.bakeryId, input.productId, current.version + 1, input.unitPriceCents],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'product.price.changed',
    entityType: 'product',
    entityId: input.productId,
    actorUserId: input.actorUserId,
    payload: {
      fromVersion: current.version,
      toVersion: next!.version,
      fromCents: current.unit_price_cents,
      toCents: input.unitPriceCents,
      existingOrdersRepriced: 0,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'product.price.change',
    entityType: 'product_price',
    entityId: next!.id,
    beforeState: { version: current.version, unitPriceCents: current.unit_price_cents },
    afterState: { version: next!.version, unitPriceCents: input.unitPriceCents },
  });
  return next!;
}

export async function publishRecipeVersion(
  client: PoolClient,
  input: {
    bakeryId: string;
    actorUserId: string;
    recipeId: string;
    ingredients: unknown;
    notes?: string | null;
  },
) {
  const current = await one<{ id: string; version: number; ingredients: unknown }>(
    `SELECT id, version, ingredients FROM recipe_versions
      WHERE recipe_id = $1 AND superseded_at IS NULL FOR UPDATE`,
    [input.recipeId],
    client,
  );
  if (!current) throw notFound('Recipe has no current version');

  await client.query('UPDATE recipe_versions SET superseded_at = now() WHERE id = $1', [current.id]);
  const next = await one<Record<string, unknown> & { id: string; version: number }>(
    `INSERT INTO recipe_versions (bakery_id, recipe_id, version, ingredients, notes)
     VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
    [
      input.bakeryId,
      input.recipeId,
      current.version + 1,
      JSON.stringify(input.ingredients),
      input.notes ?? null,
    ],
    client,
  );

  await emitEvent(client, {
    bakeryId: input.bakeryId,
    type: 'recipe.version.published',
    entityType: 'recipe',
    entityId: input.recipeId,
    actorUserId: input.actorUserId,
    payload: {
      fromVersion: current.version,
      toVersion: next!.version,
      pastRunsRewritten: 0,
    },
  });
  await writeAudit(client, {
    bakeryId: input.bakeryId,
    actorUserId: input.actorUserId,
    action: 'recipe.version.publish',
    entityType: 'recipe_version',
    entityId: next!.id,
    beforeState: { version: current.version },
    afterState: { version: next!.version, ingredients: input.ingredients },
  });
  return next!;
}

export async function priceHistory(client: PoolClient, productId: string) {
  return query(
    `SELECT version, unit_price_cents, effective_from, superseded_at
       FROM product_prices WHERE product_id = $1 ORDER BY version`,
    [productId],
    client,
  );
}

export async function recipeHistory(client: PoolClient, recipeId: string) {
  return query(
    `SELECT version, ingredients, notes, effective_from, superseded_at
       FROM recipe_versions WHERE recipe_id = $1 ORDER BY version`,
    [recipeId],
    client,
  );
}
