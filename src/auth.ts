/**
 * Authentication and tenant authorization.
 *
 * The rule this file exists to enforce: a bakery id supplied by a client is a
 * SELECTOR, never a credential. Every request re-reads the session's
 * memberships from the database and refuses anything outside them.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { one, pool, query } from './db.js';
import { forbidden, unauthorized } from './http/errors.js';
import { writeAudit } from './events.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface Membership {
  bakeryId: string;
  bakerySlug: string;
  bakeryName: string;
  role: 'OWNER' | 'STAFF' | 'READONLY';
}

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  memberships: Membership[];
}

/** Tenant-resolved context: only ever produced after a membership check. */
export interface TenantContext extends AuthContext {
  bakeryId: string;
  role: Membership['role'];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      tenant?: TenantContext;
      requestId?: string;
    }
  }
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [
    token,
    userId,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function loadAuthContext(token: string): Promise<AuthContext | null> {
  const row = await one<{
    user_id: string;
    email: string;
    display_name: string;
  }>(
    `SELECT u.id AS user_id, u.email, u.display_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
  if (!row) return null;

  const memberships = await query<{
    bakery_id: string;
    slug: string;
    name: string;
    role: Membership['role'];
  }>(
    `SELECT m.bakery_id, b.slug, b.name, m.role
       FROM memberships m
       JOIN bakeries b ON b.id = m.bakery_id
      WHERE m.user_id = $1
      ORDER BY b.slug`,
    [row.user_id],
  );

  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    memberships: memberships.map((m) => ({
      bakeryId: m.bakery_id,
      bakerySlug: m.slug,
      bakeryName: m.name,
      role: m.role,
    })),
  };
}

function bearerFrom(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  // EventSource cannot set headers; SSE endpoints accept the token in the query.
  const q = req.query.access_token;
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/** Attach the session's identity. Does not grant access to any tenant. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearerFrom(req);
  if (!token) return next(unauthorized('Missing bearer token'));
  const auth = await loadAuthContext(token);
  if (!auth) return next(unauthorized('Invalid or expired session'));
  req.auth = auth;
  next();
}

/**
 * Resolve the tenant for this request. The client-supplied id is checked
 * against server-held memberships; a miss is a 403 and is written to the
 * audit log as a DENIED action.
 */
export async function requireTenant(req: Request, _res: Response, next: NextFunction) {
  const auth = req.auth;
  if (!auth) return next(unauthorized());

  // Precedence: an explicit path parameter, then the header, then query/body.
  // Whatever wins is still only a selector - the membership lookup below is
  // what actually grants access.
  const requested =
    ((req.params && (req.params as Record<string, string>).bakeryId) ??
      req.header('x-bakery-id') ??
      (typeof req.query.bakery_id === 'string' ? req.query.bakery_id : undefined) ??
      (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).bakeryId : undefined)) as
      | string
      | undefined;

  if (!requested) {
    return next(forbidden('No bakery selected. Send X-Bakery-Id.'));
  }

  const membership = auth.memberships.find((m) => m.bakeryId === requested);
  if (!membership) {
    await writeAudit(pool, {
      bakeryId: null,
      actorUserId: auth.userId,
      action: 'tenant.access.denied',
      entityType: 'bakery',
      entityId: isUuid(requested) ? requested : null,
      outcome: 'DENIED',
      afterState: { requestedBakeryId: requested, path: req.path, method: req.method },
      requestId: req.requestId ?? null,
      ip: req.ip ?? null,
    });
    return next(forbidden('You are not a member of that bakery'));
  }

  req.tenant = { ...auth, bakeryId: membership.bakeryId, role: membership.role };
  next();
}

export function requireRole(...roles: Membership['role'][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const tenant = req.tenant;
    if (!tenant) return next(forbidden());
    if (!roles.includes(tenant.role)) {
      return next(forbidden(`Requires role ${roles.join(' or ')}; you are ${tenant.role}`));
    }
    next();
  };
}

/** Writers are OWNER or STAFF; READONLY may only read. */
export const requireWriter = requireRole('OWNER', 'STAFF');

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Defence in depth for domain code: assert a row we just read really belongs
 * to the acting tenant before touching it.
 */
export function assertSameTenant(rowBakeryId: string, tenantBakeryId: string): void {
  if (rowBakeryId !== tenantBakeryId) {
    throw forbidden('Cross-tenant access blocked');
  }
}

export async function membershipExists(
  client: PoolClient,
  userId: string,
  bakeryId: string,
): Promise<boolean> {
  const row = await one('SELECT 1 FROM memberships WHERE user_id = $1 AND bakery_id = $2', [
    userId,
    bakeryId,
  ], client);
  return row !== null;
}
