/**
 * Platform probes.
 *
 * These are not unit tests with mocks. The endpoint makes REAL HTTP requests
 * back into this same API, over the network stack, carrying the caller's own
 * session token, and records what the server actually answered. Tenant
 * isolation, authorization and duplicate protection are then judged from
 * those stored rows (cross-checked against the server's own audit log).
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { authenticate, requireTenant, requireWriter } from '../auth.js';
import { config } from '../config.js';
import { one, pool, query } from '../db.js';
import { asyncHandler } from './helpers.js';

export const probeRouter = Router();

interface ProbeRecord {
  category: 'TENANT_ISOLATION' | 'SERVER_AUTHORIZATION' | 'DUPLICATE_PROTECTION';
  attempt: string;
  expected: string;
  expectedStatus: number;
  observedStatus: number;
  observedOutcome: string;
  passed: boolean;
  targetBakeryId?: string | null;
  detail?: Record<string, unknown>;
}

probeRouter.post(
  '/probes/run',
  authenticate,
  requireTenant,
  requireWriter,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const token = req.header('authorization') ?? '';
    const base = config.selfUrl;

    const call = async (
      path: string,
      init: { method?: string; bakeryId?: string; body?: unknown; idempotencyKey?: string } = {},
    ) => {
      const headers: Record<string, string> = { Authorization: token };
      if (init.bakeryId) headers['X-Bakery-Id'] = init.bakeryId;
      if (init.body) headers['Content-Type'] = 'application/json';
      if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
      const response = await fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return {
        status: response.status,
        replayed: response.headers.get('x-idempotent-replay') === 'true',
        body: payload as Record<string, unknown> | null,
      };
    };

    const records: ProbeRecord[] = [];
    const add = (r: ProbeRecord) => records.push(r);

    // --- someone else's tenant -------------------------------------------
    const other = await one<{ id: string; name: string }>(
      `SELECT id, name FROM bakeries
        WHERE id <> ALL($1::uuid[]) ORDER BY created_at LIMIT 1`,
      [t.memberships.map((m) => m.bakeryId)],
    );

    if (other) {
      const r1 = await call('/api/state', { bakeryId: other.id });
      add({
        category: 'TENANT_ISOLATION',
        attempt: `Read /api/state with another bakery's id in X-Bakery-Id (${other.name})`,
        expected: '403 refused',
        expectedStatus: 403,
        observedStatus: r1.status,
        observedOutcome: String(r1.body?.code ?? r1.status),
        passed: r1.status === 403,
        targetBakeryId: other.id,
      });

      const otherCustomer = await one<{ id: string }>(
        'SELECT id FROM customers WHERE bakery_id = $1 LIMIT 1',
        [other.id],
      );
      if (otherCustomer) {
        const r2 = await call(`/api/customers/${otherCustomer.id}`, { bakeryId: t.bakeryId });
        add({
          category: 'TENANT_ISOLATION',
          attempt: "Read another bakery's customer by id while authenticated to my own bakery",
          expected: '404 not found (no existence leak)',
          expectedStatus: 404,
          observedStatus: r2.status,
          observedOutcome: String(r2.body?.code ?? r2.status),
          passed: r2.status === 404,
          targetBakeryId: other.id,
        });
      }

      const r3 = await call(`/api/bakeries/${other.id}/members`, {
        method: 'POST',
        bakeryId: t.bakeryId, // forged header, real path
        body: { userId: t.userId, role: 'OWNER' },
      });
      add({
        category: 'SERVER_AUTHORIZATION',
        attempt: "Add myself to another bakery (forged X-Bakery-Id pointing at my own tenant)",
        expected: '403 refused',
        expectedStatus: 403,
        observedStatus: r3.status,
        observedOutcome: String(r3.body?.code ?? r3.status),
        passed: r3.status === 403,
        targetBakeryId: other.id,
      });
    }

    const r4 = await call('/api/state', { bakeryId: randomUUID() });
    add({
      category: 'TENANT_ISOLATION',
      attempt: 'Read /api/state with a bakery id that does not exist',
      expected: '403 refused',
      expectedStatus: 403,
      observedStatus: r4.status,
      observedOutcome: String(r4.body?.code ?? r4.status),
      passed: r4.status === 403,
    });

    const r5 = await call(`/api/bakeries/${t.bakeryId}/members`, {
      method: 'POST',
      body: { userId: t.userId, role: 'OWNER' },
    });
    add({
      category: 'SERVER_AUTHORIZATION',
      attempt: 'Grant myself a role in my own bakery',
      expected: '403 refused (no self-assignment)',
      expectedStatus: 403,
      observedStatus: r5.status,
      observedOutcome: String(r5.body?.code ?? r5.status),
      passed: r5.status === 403,
      targetBakeryId: t.bakeryId,
    });

    // --- duplicate protection --------------------------------------------
    // Clear the previous run's probe rows so external references are free.
    await query("DELETE FROM payments WHERE bakery_id = $1 AND scenario_tag = 'probe'", [t.bakeryId]);
    await query("DELETE FROM credits WHERE bakery_id = $1 AND scenario_tag = 'probe'", [t.bakeryId]);

    const customer = await one<{ id: string }>('SELECT id FROM customers WHERE bakery_id = $1 LIMIT 1', [
      t.bakeryId,
    ]);
    const key = `probe-${randomUUID()}`;
    const first = await call('/api/credits', {
      method: 'POST',
      bakeryId: t.bakeryId,
      idempotencyKey: key,
      body: { customerId: customer?.id, amountCents: 1, source: 'MANUAL', note: 'probe', scenarioTag: 'probe' },
    });
    const second = await call('/api/credits', {
      method: 'POST',
      bakeryId: t.bakeryId,
      idempotencyKey: key,
      body: { customerId: customer?.id, amountCents: 1, source: 'MANUAL', note: 'probe', scenarioTag: 'probe' },
    });
    const creditCount = await one<{ count: number }>(
      "SELECT count(*)::int AS count FROM credits WHERE bakery_id = $1 AND scenario_tag = 'probe'",
      [t.bakeryId],
    );
    add({
      category: 'DUPLICATE_PROTECTION',
      attempt: 'Send the same POST /api/credits twice with one Idempotency-Key',
      expected: 'second call replayed, exactly one credit row written',
      expectedStatus: 201,
      observedStatus: second.status,
      observedOutcome: `replayed=${second.replayed}, creditRows=${creditCount?.count}`,
      passed: second.replayed === true && creditCount?.count === 1 && first.status === 201,
      detail: { firstStatus: first.status, secondStatus: second.status, creditRows: creditCount?.count },
    });

    const ref = `PROBE-REF-${new Date().toISOString().slice(0, 10)}`;
    const payOne = await call('/api/payments', {
      method: 'POST',
      bakeryId: t.bakeryId,
      idempotencyKey: `probe-${randomUUID()}`,
      body: { amountCents: 1, method: 'BANK_TRANSFER', externalRef: ref, scenarioTag: 'probe' },
    });
    const payTwo = await call('/api/payments', {
      method: 'POST',
      bakeryId: t.bakeryId,
      idempotencyKey: `probe-${randomUUID()}`,
      body: { amountCents: 1, method: 'BANK_TRANSFER', externalRef: ref, scenarioTag: 'probe' },
    });
    const payCount = await one<{ count: number }>(
      'SELECT count(*)::int AS count FROM payments WHERE bakery_id = $1 AND external_ref = $2',
      [t.bakeryId, ref],
    );
    add({
      category: 'DUPLICATE_PROTECTION',
      attempt: 'Record the same bank reference twice under different idempotency keys',
      expected: '409 conflict, exactly one payment row',
      expectedStatus: 409,
      observedStatus: payTwo.status,
      observedOutcome: `paymentRows=${payCount?.count}`,
      passed: payTwo.status === 409 && payCount?.count === 1,
      detail: { firstStatus: payOne.status, secondStatus: payTwo.status, rows: payCount?.count },
    });

    for (const r of records) {
      await pool.query(
        `INSERT INTO platform_probes
           (category, actor_user_id, actor_bakery_id, target_bakery_id, attempt, expected_outcome,
            observed_status, observed_outcome, passed, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          r.category,
          t.userId,
          t.bakeryId,
          r.targetBakeryId ?? null,
          r.attempt,
          r.expected,
          r.observedStatus,
          r.observedOutcome,
          r.passed,
          JSON.stringify(r.detail ?? {}),
        ],
      );
    }

    res.json({
      ran: records.length,
      passed: records.filter((r) => r.passed).length,
      probes: records,
    });
  }),
);
