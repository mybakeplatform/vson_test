import { Router } from 'express';
import { authenticate, requireTenant, requireWriter } from '../auth.js';
import { withTx } from '../db.js';
import { badRequest } from '../http/errors.js';
import { idempotency } from '../idempotency.js';
import { SCENARIO_KEYS, type ScenarioKey } from '../scenarios/constants.js';
import { runScenario } from '../scenarios/index.js';
import { asyncHandler } from './helpers.js';

export const scenarioRouter = Router();

scenarioRouter.post(
  '/scenarios/:key/run',
  authenticate,
  requireTenant,
  requireWriter,
  idempotency,
  asyncHandler(async (req, res) => {
    const key = req.params.key as ScenarioKey;
    if (!SCENARIO_KEYS.includes(key)) {
      throw badRequest(`Unknown scenario "${key}". Known: ${SCENARIO_KEYS.join(', ')}`);
    }
    const t = req.tenant!;
    const result = await withTx((client) =>
      runScenario(client, { bakeryId: t.bakeryId, actorUserId: t.userId }, key),
    );
    res.json({ scenario: key, result });
  }),
);
