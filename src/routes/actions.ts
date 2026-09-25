/**
 * Write endpoints: the human decisions the engines deliberately refuse to
 * take by themselves, plus the two primitives the probes exercise.
 */
import { Router } from 'express';
import { authenticate, requireTenant, requireWriter } from '../auth.js';
import { withTx } from '../db.js';
import { badRequest } from '../http/errors.js';
import { idempotency } from '../idempotency.js';
import * as consignment from '../domain/consignment.js';
import * as credit from '../domain/credit.js';
import * as payments from '../domain/payments.js';
import * as production from '../domain/production.js';
import * as tesla from '../domain/tesla.js';
import { asyncHandler } from './helpers.js';

export const actionRouter = Router();
const writer = [authenticate, requireTenant, requireWriter];

actionRouter.post(
  '/payments',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.amountCents !== 'number') throw badRequest('amountCents is required');
    const result = await withTx((client) =>
      payments.recordPayment(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        amountCents: body.amountCents as number,
        method: (body.method as 'CASH') ?? 'CASH',
        orderId: (body.orderId as string) ?? null,
        customerId: (body.customerId as string) ?? null,
        externalRef: (body.externalRef as string) ?? null,
        note: (body.note as string) ?? null,
        scenarioTag: (body.scenarioTag as string) ?? null,
      }),
    );
    res.status(201).json(result);
  }),
);

actionRouter.post(
  '/payments/exceptions/:id/resolve',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await withTx((client) =>
      payments.resolveException(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        exceptionId: req.params.id,
        resolutionCode: body.resolutionCode as payments.ResolutionCode,
        note: (body.note as string) ?? null,
        orderId: (body.orderId as string) ?? null,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/payments/suggestions/:id/accept',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const result = await withTx((client) =>
      payments.acceptSuggestion(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        suggestionId: req.params.id,
        note: (req.body?.note as string) ?? null,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/credits',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await withTx((client) =>
      credit.issueCredit(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        customerId: body.customerId as string,
        amountCents: body.amountCents as number,
        source: (body.source as 'MANUAL') ?? 'MANUAL',
        note: (body.note as string) ?? null,
        scenarioTag: (body.scenarioTag as string) ?? null,
      }),
    );
    res.status(201).json({ credit: result });
  }),
);

actionRouter.post(
  '/credits/:id/apply',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await withTx((client) =>
      credit.applyCredit(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        creditId: req.params.id,
        orderId: body.orderId as string,
        amountCents: body.amountCents as number,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/consignment/discrepancies/:id/resolve',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await withTx((client) =>
      consignment.resolveDiscrepancy(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        discrepancyId: req.params.id,
        resolutionCode: body.resolutionCode as consignment.ResolutionCode,
        note: (body.note as string) ?? null,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/recommendations/:id/decide',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.decision !== 'ACCEPT' && body.decision !== 'REJECT') {
      throw badRequest('decision must be ACCEPT or REJECT');
    }
    const result = await withTx((client) =>
      tesla.decide(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        recommendationId: req.params.id,
        decision: body.decision as 'ACCEPT' | 'REJECT',
        note: (body.note as string) ?? null,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/commitments/:id/split',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await withTx((client) =>
      production.splitCommitment(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        commitmentId: req.params.id,
        segments: body.segments as { quantity: number; plannedDate: string }[],
        reason: (body.reason as string) ?? 'Operational split',
        runId: (body.runId as string) ?? null,
      }),
    );
    res.json(result);
  }),
);

actionRouter.post(
  '/fulfillment-segments/:id/fulfill',
  writer,
  idempotency,
  asyncHandler(async (req, res) => {
    const t = req.tenant!;
    const result = await withTx((client) =>
      production.fulfillSegment(client, {
        bakeryId: t.bakeryId,
        actorUserId: t.userId,
        segmentId: req.params.id,
      }),
    );
    res.json(result);
  }),
);
