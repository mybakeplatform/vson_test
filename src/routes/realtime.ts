/**
 * Realtime endpoints.
 *
 * /stream  the SSE socket. It carries pointers, not data: on every frame the
 *          client comes back over HTTP for authoritative state.
 * /probe   raise a deliberate, uniquely-tagged event in the caller's tenant.
 * /report  the client says which probes it actually received; receipts and
 *          the absence of receipts are the evidence the realtime check reads.
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { authenticate, requireTenant } from '../auth.js';
import { one, withTx } from '../db.js';
import { emitEvent } from '../events.js';
import { subscribe } from '../realtime.js';
import { asyncHandler } from './helpers.js';

export const realtimeRouter = Router();

realtimeRouter.get(
  '/realtime/stream',
  authenticate,
  requireTenant,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ bakeryId: t.bakeryId })}\n\n`);

    const unsubscribe = subscribe(t.bakeryId, t.userId, res);
    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  }),
);

realtimeRouter.post(
  '/realtime/probe',
  authenticate,
  requireTenant,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const nonce = `probe_${randomBytes(8).toString('hex')}`;
    const probe = await withTx(async (client) => {
      const row = await one<{ id: string }>(
        'INSERT INTO realtime_probes (bakery_id, nonce, raised_by) VALUES ($1,$2,$3) RETURNING id',
        [t.bakeryId, nonce, t.userId],
        client,
      );
      // The NOTIFY is a side effect of this INSERT, via the events trigger.
      await emitEvent(client, {
        bakeryId: t.bakeryId,
        type: 'realtime.probe',
        entityType: 'realtime_probe',
        entityId: row!.id,
        actorUserId: t.userId,
        payload: { nonce },
      });
      return row!;
    });
    res.status(201).json({ probeId: probe.id, nonce, raisedAt: Date.now() });
  }),
);

realtimeRouter.post(
  '/realtime/report',
  authenticate,
  requireTenant,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as {
      sameTenantProbeId?: string;
      crossTenantProbeId?: string;
      received?: { nonce: string; latencyMs?: number }[];
    };
    const received = body.received ?? [];

    const stored = await withTx(async (client) => {
      const receipts: string[] = [];
      for (const item of received) {
        const probe = await one<{ id: string }>('SELECT id FROM realtime_probes WHERE nonce = $1', [
          item.nonce,
        ], client);
        if (!probe) continue;
        await client.query(
          `INSERT INTO realtime_receipts (probe_id, subscriber_bakery_id, subscriber_user_id, latency_ms)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (probe_id, subscriber_bakery_id, subscriber_user_id) DO NOTHING`,
          [probe.id, t.bakeryId, t.userId, item.latencyMs ?? null],
        );
        receipts.push(probe.id);
      }
      const result = {
        sameTenantProbeId: body.sameTenantProbeId ?? null,
        crossTenantProbeId: body.crossTenantProbeId ?? null,
        receivedNonces: received.map((r) => r.nonce),
        subscriberBakeryId: t.bakeryId,
        receiptProbeIds: receipts,
      };
      await client.query(
        "INSERT INTO scenario_runs (bakery_id, scenario, actor_user_id, result) VALUES ($1,'realtime',$2,$3::jsonb)",
        [t.bakeryId, t.userId, JSON.stringify(result)],
      );
      return result;
    });

    res.json(stored);
  }),
);
