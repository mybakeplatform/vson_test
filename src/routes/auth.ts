import { Router } from 'express';
import {
  authenticate,
  createSession,
  loadAuthContext,
  requireRole,
  requireTenant,
  verifyPassword,
} from '../auth.js';
import { one, pool, query, withTx } from '../db.js';
import { writeAudit } from '../events.js';
import { badRequest, forbidden, notFound, unauthorized } from '../http/errors.js';
import { asyncHandler } from './helpers.js';

export const authRouter = Router();

authRouter.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || !password) throw badRequest('email and password are required');

    const user = await one<{ id: string; password_hash: string; display_name: string }>(
      'SELECT id, password_hash, display_name FROM users WHERE email = $1',
      [email.toLowerCase().trim()],
    );
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw unauthorized('Email or password is wrong');
    }

    const session = await createSession(user.id);
    const auth = await loadAuthContext(session.token);
    res.json({ token: session.token, expiresAt: session.expiresAt, user: auth });
  }),
);

authRouter.get(
  '/auth/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: req.auth });
  }),
);

authRouter.post(
  '/auth/logout',
  authenticate,
  asyncHandler(async (req, res) => {
    const token = req.header('authorization')?.slice(7).trim();
    if (token) await query('DELETE FROM sessions WHERE token = $1', [token]);
    res.json({ ok: true });
  }),
);

/** Only the bakeries this session is actually a member of. */
authRouter.get(
  '/bakeries',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ bakeries: req.auth!.memberships });
  }),
);

/**
 * Membership management.
 *
 * Two rules, both server-side:
 *   - only an OWNER of the target bakery may add anyone
 *   - nobody may add themselves, to any bakery, ever
 * There is no endpoint anywhere that lets a session move itself between
 * tenants.
 */
authRouter.post(
  '/bakeries/:bakeryId/members',
  authenticate,
  requireTenant,
  requireRole('OWNER'),
  asyncHandler(async (req, res) => {
    const tenant = req.tenant!;
    const { userId, role } = (req.body ?? {}) as { userId?: string; role?: string };
    if (!userId || !role) throw badRequest('userId and role are required');

    if (userId === tenant.userId) {
      await writeAudit(pool, {
        bakeryId: tenant.bakeryId,
        actorUserId: tenant.userId,
        action: 'membership.self_assignment.denied',
        entityType: 'membership',
        outcome: 'DENIED',
        afterState: { requestedRole: role },
      });
      throw forbidden('A user cannot grant themselves membership');
    }
    if (!['OWNER', 'STAFF', 'READONLY'].includes(role)) throw badRequest('Unknown role');

    const result = await withTx(async (client) => {
      const target = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId], client);
      if (!target) throw notFound('User not found');
      const row = await one<Record<string, unknown>>(
        `INSERT INTO memberships (user_id, bakery_id, role, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, bakery_id) DO UPDATE SET role = EXCLUDED.role
         RETURNING *`,
        [userId, tenant.bakeryId, role, tenant.userId],
        client,
      );
      await writeAudit(client, {
        bakeryId: tenant.bakeryId,
        actorUserId: tenant.userId,
        action: 'membership.grant',
        entityType: 'membership',
        entityId: row!.id as string,
        afterState: { userId, role },
      });
      return row!;
    });

    res.status(201).json({ membership: result });
  }),
);
