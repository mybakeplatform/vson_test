/**
 * Domain events and audit trail.
 *
 * events    - what happened in the business, append-only, drives realtime
 * audit_log - who did it (including refused attempts), append-only
 *
 * Both are written inside the same transaction as the change they describe,
 * so evidence can never drift from state.
 */
import type { Pool, PoolClient } from 'pg';
import { one } from './db.js';

export type Sql = Pool | PoolClient;

export interface EventInput {
  bakeryId: string;
  type: string;
  entityType: string;
  entityId?: string | null;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
}

export async function emitEvent(client: Sql, input: EventInput): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO events (bakery_id, type, entity_type, entity_id, payload, actor_user_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      input.bakeryId,
      input.type,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.actorUserId ?? null,
    ],
    client,
  );
  return row!.id;
}

export interface AuditInput {
  bakeryId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  outcome?: 'ALLOWED' | 'DENIED';
  beforeState?: unknown;
  afterState?: unknown;
  requestId?: string | null;
  ip?: string | null;
}

export async function writeAudit(client: Sql, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
       (bakery_id, actor_user_id, action, entity_type, entity_id, outcome,
        before_state, after_state, request_id, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      input.bakeryId,
      input.actorUserId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.outcome ?? 'ALLOWED',
      input.beforeState === undefined ? null : JSON.stringify(input.beforeState),
      input.afterState === undefined ? null : JSON.stringify(input.afterState),
      input.requestId ?? null,
      input.ip ?? null,
    ],
  );
}

/** Convenience: record the business event and the audit entry together. */
export async function record(
  client: Sql,
  event: EventInput,
  audit: Omit<AuditInput, 'bakeryId' | 'actorUserId'> & { bakeryId?: string },
): Promise<void> {
  await emitEvent(client, event);
  await writeAudit(client, {
    bakeryId: audit.bakeryId ?? event.bakeryId,
    actorUserId: event.actorUserId ?? null,
    ...audit,
  });
}
