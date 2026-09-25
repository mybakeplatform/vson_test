/**
 * Duplicate protection for unsafe requests.
 *
 * Send `Idempotency-Key: <opaque>` with a POST. The first call runs and its
 * response is stored; any repeat with the same key returns the stored
 * response and never re-executes the business rule. A repeat that carries a
 * DIFFERENT body is rejected (409) rather than silently answered.
 */
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { one, pool, query } from './db.js';
import { conflict, forbidden } from './http/errors.js';

function hashBody(req: Request): string {
  return createHash('sha256')
    .update(JSON.stringify({ path: req.path, body: req.body ?? null }))
    .digest('hex');
}

export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.header('idempotency-key');
  if (!key) return next();

  const tenant = req.tenant;
  if (!tenant) return next(forbidden('Idempotent requests require a tenant'));

  const endpoint = `${req.method} ${req.route?.path ?? req.path}`;
  const requestHash = hashBody(req);

  const inserted = await one<{ key: string }>(
    `INSERT INTO idempotency_keys (bakery_id, key, endpoint, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bakery_id, key) DO NOTHING
     RETURNING key`,
    [tenant.bakeryId, key, endpoint, requestHash],
  );

  if (!inserted) {
    const existing = await one<{
      endpoint: string;
      request_hash: string;
      state: string;
      status_code: number | null;
      response_body: unknown;
    }>(
      `SELECT endpoint, request_hash, state, status_code, response_body
         FROM idempotency_keys WHERE bakery_id = $1 AND key = $2`,
      [tenant.bakeryId, key],
    );
    if (!existing) return next(conflict('Idempotency key vanished mid-flight; retry'));
    if (existing.request_hash !== requestHash || existing.endpoint !== endpoint) {
      return next(
        conflict('Idempotency key was already used with a different request', {
          key,
          firstEndpoint: existing.endpoint,
        }),
      );
    }
    if (existing.state === 'IN_FLIGHT') {
      return next(conflict('An identical request is still in flight', { key }));
    }
    await query(
      'UPDATE idempotency_keys SET replay_count = replay_count + 1 WHERE bakery_id = $1 AND key = $2',
      [tenant.bakeryId, key],
    );
    res.setHeader('X-Idempotent-Replay', 'true');
    res.status(existing.status_code ?? 200).json(existing.response_body);
    return;
  }

  // First execution: capture the response so a replay can be served verbatim.
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const statusCode = res.statusCode;
    pool
      .query(
        `UPDATE idempotency_keys
            SET state = 'COMPLETED', status_code = $3, response_body = $4::jsonb, completed_at = now()
          WHERE bakery_id = $1 AND key = $2`,
        [tenant.bakeryId, key, statusCode, JSON.stringify(body ?? null)],
      )
      .catch((err) => console.error('[idempotency] failed to persist response', err.message));
    return originalJson(body);
  };

  res.on('finish', () => {
    if (res.statusCode >= 400) {
      // A failed attempt must not block a legitimate retry.
      pool
        .query('DELETE FROM idempotency_keys WHERE bakery_id = $1 AND key = $2 AND state = $3', [
          tenant.bakeryId,
          key,
          'IN_FLIGHT',
        ])
        .catch(() => undefined);
    }
  });

  next();
}
