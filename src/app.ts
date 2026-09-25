import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { HttpError } from './http/errors.js';
import { actionRouter } from './routes/actions.js';
import { authRouter } from './routes/auth.js';
import { probeRouter } from './routes/probes.js';
import { readRouter } from './routes/read.js';
import { realtimeRouter } from './routes/realtime.js';
import { scenarioRouter } from './routes/scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    req.requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const origin = req.header('origin');
    if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Bakery-Id, Idempotency-Key');
      res.setHeader('Access-Control-Expose-Headers', 'X-Idempotent-Replay, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use('/api', authRouter);
  app.use('/api', readRouter);
  app.use('/api', actionRouter);
  app.use('/api', scenarioRouter);
  app.use('/api', realtimeRouter);
  app.use('/api', probeRouter);

  // The diagnostic console.
  app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown endpoint', code: 'NOT_FOUND' });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        details: err.details,
        requestId: req.requestId,
      });
      return;
    }
    const pgError = err as { code?: string; constraint?: string; message?: string };
    if (pgError?.code === '23505') {
      res.status(409).json({
        error: 'That record already exists',
        code: 'DUPLICATE',
        details: { constraint: pgError.constraint },
        requestId: req.requestId,
      });
      return;
    }
    if (pgError?.code === '23514' || pgError?.code === '23503') {
      res.status(422).json({
        error: pgError.message ?? 'Constraint violation',
        code: 'CONSTRAINT_VIOLATION',
        details: { constraint: pgError.constraint },
        requestId: req.requestId,
      });
      return;
    }
    console.error(`[error] ${req.method} ${req.path}`, err);
    res.status(500).json({
      error: 'Internal error',
      code: 'INTERNAL',
      message: pgError?.message ?? String(err),
      requestId: req.requestId,
    });
  });

  return app;
}
