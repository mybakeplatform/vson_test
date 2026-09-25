/**
 * Read endpoints. Every query is filtered by the resolved tenant, so an id
 * belonging to another bakery simply does not exist here (404, never a leak).
 */
import { Router } from 'express';
import { authenticate, requireTenant } from '../auth.js';
import { one, pool, query, withTx } from '../db.js';
import { notFound } from '../http/errors.js';
import { runChecks, summarise } from '../checks/index.js';
import * as availability from '../domain/availability.js';
import * as tesla from '../domain/tesla.js';
import { openDiscrepancies } from '../domain/consignment.js';
import { DATES, SCENARIO_TITLES, SCENARIO_KEYS } from '../scenarios/constants.js';
import { isListening, subscriberCount } from '../realtime.js';
import { asyncHandler } from './helpers.js';

export const readRouter = Router();
const tenantOnly = [authenticate, requireTenant];

readRouter.get(
  '/state',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const b = req.tenant!.bakeryId;
    const [products, customers, orders, counts] = await Promise.all([
      query(
        `SELECT p.id, p.sku, p.name,
                pp.unit_price_cents AS current_price_cents, pp.version AS price_version,
                ap.soft_threshold, ap.hard_limit, ap.overflow_allowance, ap.max_units
           FROM products p
           LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.superseded_at IS NULL
           LEFT JOIN availability_policies ap ON ap.product_id = p.id
          WHERE p.bakery_id = $1 ORDER BY p.name`,
        [b],
      ),
      query('SELECT id, name, kind FROM customers WHERE bakery_id = $1 ORDER BY name', [b]),
      query(
        `SELECT o.id, o.code, o.channel, o.status, o.scheduled_date, o.total_cents,
                o.scenario_tag, c.name AS customer_name,
                (o.total_cents
                  - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id),0)
                  - coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id),0))::int
                  AS outstanding_cents
           FROM orders o JOIN customers c ON c.id = o.customer_id
          WHERE o.bakery_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
        [b],
      ),
      one(
        `SELECT
           (SELECT count(*) FROM orders WHERE bakery_id = $1)::int AS orders,
           (SELECT count(*) FROM commitments WHERE bakery_id = $1)::int AS commitments,
           (SELECT count(*) FROM payments WHERE bakery_id = $1)::int AS payments,
           (SELECT count(*) FROM events WHERE bakery_id = $1)::int AS events,
           (SELECT count(*) FROM audit_log WHERE bakery_id = $1)::int AS audit_rows,
           (SELECT count(*) FROM production_runs WHERE bakery_id = $1)::int AS production_runs`,
        [b],
      ),
    ]);

    res.json({
      bakery: { id: b, role: req.tenant!.role },
      products,
      customers,
      orders,
      counts,
      realtime: { listening: isListening(), subscribers: subscriberCount(b) },
    });
  }),
);

readRouter.get(
  '/orders/:id',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const b = req.tenant!.bakeryId;
    const order = await one(
      'SELECT * FROM orders WHERE id = $1 AND bakery_id = $2',
      [req.params.id, b],
    );
    if (!order) throw notFound('Order not found');
    const [lines, commitments, assignments, payments, credits, segments] = await Promise.all([
      query(
        `SELECT ol.*, p.sku, pp.version AS price_version
           FROM order_lines ol JOIN products p ON p.id = ol.product_id
           JOIN product_prices pp ON pp.id = ol.price_version_id
          WHERE ol.order_id = $1`,
        [req.params.id],
      ),
      query('SELECT * FROM commitments WHERE order_id = $1 ORDER BY created_at', [req.params.id]),
      query('SELECT * FROM shipping_assignments WHERE order_id = $1 ORDER BY sequence', [req.params.id]),
      query(
        `SELECT pa.*, p.amount_cents AS payment_amount_cents FROM payment_allocations pa
           JOIN payments p ON p.id = pa.payment_id WHERE pa.order_id = $1`,
        [req.params.id],
      ),
      query('SELECT * FROM credit_allocations WHERE order_id = $1 ORDER BY sequence', [req.params.id]),
      query('SELECT * FROM fulfillment_segments WHERE order_id = $1 ORDER BY sequence', [req.params.id]),
    ]);
    res.json({ order, lines, commitments, assignments, payments, credits, segments });
  }),
);

readRouter.get(
  '/customers/:id',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const customer = await one('SELECT * FROM customers WHERE id = $1 AND bakery_id = $2', [
      req.params.id,
      req.tenant!.bakeryId,
    ]);
    if (!customer) throw notFound('Customer not found');
    res.json({ customer });
  }),
);

readRouter.get(
  '/availability',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const productId = String(req.query.product_id ?? '');
    const serviceDate = String(req.query.service_date ?? DATES.availability);
    const snapshot = await withTx((client) =>
      availability.snapshot(client, req.tenant!.bakeryId, productId, serviceDate),
    );
    res.json(snapshot);
  }),
);

readRouter.get(
  '/events',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const events = await query(
      `SELECT e.id, e.type, e.entity_type, e.entity_id, e.payload, e.created_at,
              u.display_name AS actor
         FROM events e LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.bakery_id = $1 ORDER BY e.id DESC LIMIT $2`,
      [req.tenant!.bakeryId, limit],
    );
    res.json({ events });
  }),
);

readRouter.get(
  '/audit',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const rows = await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.outcome, a.before_state,
              a.after_state, a.created_at, u.display_name AS actor
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.bakery_id = $1 ORDER BY a.id DESC LIMIT $2`,
      [req.tenant!.bakeryId, limit],
    );
    res.json({ audit: rows });
  }),
);

/** Everything that is waiting on a person. */
readRouter.get(
  '/inbox',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const b = req.tenant!.bakeryId;
    const [exceptions, discrepancies, recommendations, impacts] = await Promise.all([
      query(
        `SELECT e.*, p.amount_cents AS payment_amount_cents, p.order_id AS payment_order_id,
                (SELECT json_agg(json_build_object('id', s.id, 'orderId', s.order_id, 'orderCode', o.code,
                                                   'amountCents', s.amount_cents, 'confidence', s.confidence,
                                                   'rationale', s.rationale, 'status', s.status)
                                 ORDER BY s.confidence DESC)
                   FROM payment_suggestions s LEFT JOIN orders o ON o.id = s.order_id
                  WHERE s.exception_id = e.id) AS suggestions
           FROM payment_exceptions e JOIN payments p ON p.id = e.payment_id
          WHERE e.bakery_id = $1 AND e.status = 'OPEN' ORDER BY e.created_at DESC`,
        [b],
      ),
      withTx((client) => openDiscrepancies(client, b)),
      withTx((client) => tesla.history(client, b)),
      query(
        `SELECT i.*, o.code AS order_code FROM production_failure_impacts i
           JOIN orders o ON o.id = i.order_id
          WHERE i.bakery_id = $1 AND i.resolution = 'AWAITING_HUMAN' ORDER BY i.created_at DESC`,
        [b],
      ),
    ]);
    res.json({ paymentExceptions: exceptions, discrepancies, recommendations, productionImpacts: impacts });
  }),
);

readRouter.get(
  '/checks',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const results = await withTx((client) => runChecks(client, req.tenant!.bakeryId));
    res.json({ summary: summarise(results), checks: results, generatedAt: new Date().toISOString() });
  }),
);

readRouter.get(
  '/scenarios',
  tenantOnly,
  asyncHandler(async (req, res) => {
    const runs = await query(
      `SELECT DISTINCT ON (scenario) scenario, created_at, result
         FROM scenario_runs WHERE bakery_id = $1 ORDER BY scenario, created_at DESC`,
      [req.tenant!.bakeryId],
    );
    res.json({
      scenarios: SCENARIO_KEYS.map((key) => ({
        key,
        title: SCENARIO_TITLES[key],
        lastRun: runs.find((r) => (r as { scenario: string }).scenario === key) ?? null,
      })),
    });
  }),
);

readRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const row = await one<{ ok: number }>('SELECT 1 AS ok');
    res.json({
      ok: row?.ok === 1,
      database: row?.ok === 1 ? 'up' : 'down',
      realtimeListener: isListening(),
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    });
  }),
);
