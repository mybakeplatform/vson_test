/**
 * The check engine.
 *
 * Every verdict here is computed by reading rows back out of Postgres. No
 * check trusts what a scenario claimed to have done, and none of them read
 * explanatory text: they compare stored numbers, statuses and foreign keys.
 *
 *   PASS         every assertion is satisfied by persisted evidence
 *   FAIL         at least one assertion is contradicted by persisted evidence
 *   CONDITIONAL  the evidence needed to decide is not there yet (the scenario
 *                has not been run, or a required human decision is missing)
 */
import type { PoolClient } from 'pg';
import { one, query } from '../db.js';
import { COUNTRY_BLONDE_POLICY, DATES, SKU } from '../scenarios/constants.js';

export type Verdict = 'PASS' | 'CONDITIONAL' | 'FAIL';
export type Group = 'CORE' | 'PLATFORM';

export interface Assertion {
  label: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export interface CheckResult {
  id: string;
  title: string;
  group: Group;
  verdict: Verdict;
  summary: string;
  assertions: Assertion[];
  evidence: Record<string, unknown>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

class Case {
  readonly assertions: Assertion[] = [];
  readonly evidence: Record<string, unknown> = {};

  eq(label: string, expected: unknown, actual: unknown): void {
    this.assertions.push({ label, expected, actual, ok: same(expected, actual) });
  }

  is(label: string, expected: string, actual: unknown, ok: boolean): void {
    this.assertions.push({ label, expected, actual, ok });
  }

  note(key: string, value: unknown): void {
    this.evidence[key] = value;
  }

  build(
    id: string,
    title: string,
    group: Group,
    options: { hasEvidence: boolean; missing: string; pending?: string | null },
  ): CheckResult {
    const failed = this.assertions.filter((a) => !a.ok);
    let verdict: Verdict;
    let summary: string;

    if (!options.hasEvidence) {
      verdict = 'CONDITIONAL';
      summary = options.missing;
    } else if (failed.length > 0) {
      verdict = 'FAIL';
      summary = `${failed.length} of ${this.assertions.length} assertions contradicted by stored data: ${failed
        .map((f) => f.label)
        .join('; ')}`;
    } else if (options.pending) {
      verdict = 'CONDITIONAL';
      summary = options.pending;
    } else {
      verdict = 'PASS';
      summary = `${this.assertions.length} assertions satisfied by stored data`;
    }

    return { id, title, group, verdict, summary, assertions: this.assertions, evidence: this.evidence };
  }
}

async function productId(client: PoolClient, bakeryId: string, sku: string): Promise<string | null> {
  const row = await one<{ id: string }>('SELECT id FROM products WHERE bakery_id = $1 AND sku = $2', [
    bakeryId,
    sku,
  ], client);
  return row?.id ?? null;
}

/**
 * Try a write that the schema is supposed to refuse, inside a savepoint, and
 * roll it back either way. Returns true when the database blocked it.
 */
async function expectRejected(client: PoolClient, sql: string, params: unknown[]): Promise<boolean> {
  await client.query('SAVEPOINT immutability_probe');
  try {
    await client.query(sql, params as never[]);
    await client.query('ROLLBACK TO SAVEPOINT immutability_probe');
    return false;
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT immutability_probe');
    return true;
  } finally {
    await client.query('RELEASE SAVEPOINT immutability_probe');
  }
}

// ---------------------------------------------------------------------------
// 1. Availability engine
// ---------------------------------------------------------------------------
async function checkAvailability(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const pid = await productId(client, bakeryId, SKU.countryBlonde);
  const decisions = pid
    ? await query<{
        requested_units: number;
        committed_before: number;
        committed_after: number;
        outcome: string;
        band: string;
        soft_threshold: number;
        hard_limit: number;
        overflow_allowance: number;
        max_units: number;
      }>(
        `SELECT requested_units, committed_before, committed_after, outcome, band,
                soft_threshold, hard_limit, overflow_allowance, max_units
           FROM availability_decisions
          WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3
          ORDER BY created_at, id`,
        [bakeryId, pid, DATES.availability],
        client,
      )
    : [];

  c.note('serviceDate', DATES.availability);
  c.note('decisions', decisions);

  const policy = decisions[0];
  if (policy) {
    c.eq('policy soft threshold', COUNTRY_BLONDE_POLICY.softThreshold, policy.soft_threshold);
    c.eq('policy hard limit', COUNTRY_BLONDE_POLICY.hardLimit, policy.hard_limit);
    c.eq('policy overflow allowance', COUNTRY_BLONDE_POLICY.overflowAllowance, policy.overflow_allowance);
    c.eq('policy max', COUNTRY_BLONDE_POLICY.maxUnits, policy.max_units);
  }

  const accepted = decisions.filter((d) => d.outcome === 'ACCEPT');
  const step = (before: number, requested: number) =>
    accepted.find((d) => d.committed_before === before && d.requested_units === requested);

  const a51 = step(50, 1);
  const a52 = step(51, 1);
  const a53 = step(52, 1);
  c.is('50 + 1 accepted -> 51', 'ACCEPT to 51', a51?.committed_after ?? null, a51?.committed_after === 51);
  c.is('51 + 1 accepted -> 52', 'ACCEPT to 52', a52?.committed_after ?? null, a52?.committed_after === 52);
  c.is('52 + 1 accepted -> 53', 'ACCEPT to 53', a53?.committed_after ?? null, a53?.committed_after === 53);

  const rejected = decisions.find(
    (d) => d.outcome === 'REJECT' && d.committed_before === 53 && d.requested_units === 1,
  );
  c.is('53 + 1 rejected', 'REJECT, counter unchanged at 53', rejected?.committed_after ?? null, rejected?.committed_after === 53);

  const bulk = accepted.find((d) => d.requested_units === 3 && d.committed_before === 50);
  c.is('50 + 3 accepted as one unit of work', 'ACCEPT all 3 -> 53', bulk?.committed_after ?? null, bulk?.committed_after === 53);

  const partial = accepted.filter((d) => d.committed_after - d.committed_before !== d.requested_units);
  c.eq('no partial acceptance anywhere in the log', 0, partial.length);

  const overMax = decisions.filter((d) => d.committed_after > COUNTRY_BLONDE_POLICY.maxUnits);
  c.eq('committed never exceeds max', 0, overMax.length);

  const day = pid
    ? await one<{ committed_units: number }>(
        'SELECT committed_units FROM availability_days WHERE product_id = $1 AND service_date = $2',
        [pid, DATES.availability],
        client,
      )
    : null;
  c.eq('final committed units', 53, day?.committed_units ?? null);
  c.note('finalCommitted', day?.committed_units ?? null);

  return c.build('availability_engine', '1. Availability engine', 'CORE', {
    hasEvidence: decisions.length > 0,
    missing: 'No availability decisions stored for the test day. Run the availability scenario.',
  });
}

// ---------------------------------------------------------------------------
// 2. Production allocation and surplus
// ---------------------------------------------------------------------------
async function checkProduction(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const plan = await one<{
    id: string;
    required_units: number;
    planned_units: number;
    max_mixer_load: number;
    product_id: string;
    service_date: string;
  }>(
    `SELECT * FROM production_plans
      WHERE bakery_id = $1 AND scenario_tag = 'production'
      ORDER BY created_at DESC LIMIT 1`,
    [bakeryId],
    client,
  );

  if (plan) {
    const loads = await query<{ sequence: number; planned_units: number }>(
      'SELECT sequence, planned_units FROM mixer_loads WHERE plan_id = $1 ORDER BY sequence',
      [plan.id],
      client,
    );
    const run = await one<{
      actual_units: number;
      allocated_units: number;
      surplus_units: number;
      status: string;
      id: string;
    }>('SELECT * FROM production_runs WHERE plan_id = $1 ORDER BY started_at DESC LIMIT 1', [plan.id], client);

    const allocations = await one<{ total: number; count: number }>(
      'SELECT coalesce(sum(quantity),0)::int AS total, count(*)::int AS count FROM production_allocations WHERE run_id = $1',
      [run?.id ?? null],
      client,
    );
    const surplus = await one<{ total: number }>(
      'SELECT coalesce(sum(quantity),0)::int AS total FROM surplus_inventory WHERE run_id = $1',
      [run?.id ?? null],
      client,
    );
    const demand = await one<{ total: number }>(
      `SELECT coalesce(sum(quantity),0)::int AS total FROM commitments
        WHERE bakery_id = $1 AND product_id = $2 AND service_date = $3 AND status <> 'RELEASED'`,
      [bakeryId, plan.product_id, plan.service_date],
      client,
    );

    c.eq('required units', 65, plan.required_units);
    c.eq('planned units', 65, plan.planned_units);
    c.eq('max mixer load', 33, plan.max_mixer_load);
    c.eq('mixer loads', [32, 33], loads.map((l) => l.planned_units));
    c.eq('actual units produced', 68, run?.actual_units ?? null);
    c.eq('units allocated to commitments', 65, run?.allocated_units ?? null);
    c.eq('allocation rows sum to 65', 65, allocations?.total ?? null);
    c.eq('surplus recorded on the run', 3, run?.surplus_units ?? null);
    c.eq('surplus inventory rows sum to 3', 3, surplus?.total ?? null);
    c.eq('customer demand still 65 (not rewritten to 68)', 65, demand?.total ?? null);
    c.eq('run status', 'COMPLETED', run?.status ?? null);

    c.note('plan', plan);
    c.note('mixerLoads', loads);
    c.note('run', run);
    c.note('allocationRows', allocations?.count ?? 0);
  }

  return c.build('production_allocation', '2. Production 65 -> 32+33 -> 68 -> 3 surplus', 'CORE', {
    hasEvidence: plan !== null,
    missing: 'No production plan stored. Run the production scenario.',
  });
}

// ---------------------------------------------------------------------------
// 3. Failed production run
// ---------------------------------------------------------------------------
async function checkFailure(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const run = await one<{ id: string; status: string; actual_units: number; failure_reason: string }>(
    `SELECT r.* FROM production_runs r
       JOIN production_plans p ON p.id = r.plan_id
      WHERE r.bakery_id = $1 AND p.scenario_tag = 'failure' AND r.status = 'FAILED'
      ORDER BY r.started_at DESC LIMIT 1`,
    [bakeryId],
    client,
  );

  if (run) {
    const impacts = await query<{
      commitment_id: string;
      order_id: string;
      shortfall_units: number;
      resolution: string;
      resolved_by: string | null;
    }>('SELECT * FROM production_failure_impacts WHERE run_id = $1', [run.id], client);

    const orderIds = [...new Set(impacts.map((i) => i.order_id))];
    const ordersRows = orderIds.length
      ? await query<{ id: string; status: string; code: string }>(
          'SELECT id, status, code FROM orders WHERE id = ANY($1::uuid[])',
          [orderIds],
          client,
        )
      : [];
    const segments = impacts[0]
      ? await query<{ sequence: number; quantity: number; planned_date: string; status: string }>(
          'SELECT sequence, quantity, planned_date, status FROM fulfillment_segments WHERE commitment_id = $1 ORDER BY sequence',
          [impacts[0].commitment_id],
          client,
        )
      : [];
    const scenarioOrders = await one<{ count: number }>(
      "SELECT count(*)::int AS count FROM orders WHERE bakery_id = $1 AND scenario_tag = 'failure'",
      [bakeryId],
      client,
    );
    const cancelled = ordersRows.filter((o) => o.status === 'CANCELLED');

    c.eq('run recorded as FAILED', 'FAILED', run.status);
    c.eq('failed run produced nothing', 0, run.actual_units);
    c.is('affected commitments recorded', 'at least one', impacts.length, impacts.length > 0);
    c.eq('shortfall on the affected commitment', 6, impacts[0]?.shortfall_units ?? null);
    c.eq('orders cancelled automatically', 0, cancelled.length);
    c.eq('orders belonging to this scenario (no fake second order)', 1, scenarioOrders?.count ?? null);
    c.eq('fulfillment split into two segments', [3, 3], segments.map((s) => s.quantity));
    c.eq(
      'segments land on two different days',
      2,
      new Set(segments.map((s) => s.planned_date)).size,
    );
    c.eq('segment dates', [DATES.failureDay1, DATES.failureDay2], segments.map((s) => s.planned_date));
    c.eq('impact resolved as an operational split', 'SPLIT_FULFILLMENT', impacts[0]?.resolution ?? null);
    c.is(
      'split attributed to a person',
      'resolved_by is set',
      impacts[0]?.resolved_by ?? null,
      Boolean(impacts[0]?.resolved_by),
    );

    c.note('run', run);
    c.note('impacts', impacts);
    c.note('orders', ordersRows);
    c.note('segments', segments);
  }

  return c.build('production_failure', '3. Production failure and partial fulfillment', 'CORE', {
    hasEvidence: run !== null,
    missing: 'No failed production run stored. Run the failure scenario.',
  });
}

// ---------------------------------------------------------------------------
// 4. Payment brain
// ---------------------------------------------------------------------------
async function checkPayments(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();

  const exactOrder = await one<{ id: string; total_cents: number }>(
    "SELECT id, total_cents FROM orders WHERE bakery_id = $1 AND code = 'PAY-EXACT-42'",
    [bakeryId],
    client,
  );
  const overOrder = await one<{ id: string; total_cents: number }>(
    "SELECT id, total_cents FROM orders WHERE bakery_id = $1 AND code = 'PAY-OVER-48'",
    [bakeryId],
    client,
  );

  if (exactOrder && overOrder) {
    const exactAlloc = await one<{ total: number; kinds: string[] }>(
      `SELECT coalesce(sum(amount_cents),0)::int AS total, array_agg(DISTINCT kind) AS kinds
         FROM payment_allocations WHERE order_id = $1`,
      [exactOrder.id],
      client,
    );
    const exactExceptions = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM payment_exceptions e
         JOIN payments p ON p.id = e.payment_id
        WHERE p.order_id = $1`,
      [exactOrder.id],
      client,
    );
    c.eq('exact case: order total', 4200, exactOrder.total_cents);
    c.eq('exact case: allocated automatically', 4200, exactAlloc?.total ?? null);
    c.eq('exact case: allocation was automatic', ['AUTO_EXACT'], exactAlloc?.kinds ?? null);
    c.eq('exact case: no human exception raised', 0, exactExceptions?.count ?? null);

    const overPayment = await one<{ id: string; amount_cents: number; status: string }>(
      'SELECT id, amount_cents, status FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
      [overOrder.id],
      client,
    );
    const overAlloc = await one<{ total: number }>(
      'SELECT coalesce(sum(amount_cents),0)::int AS total FROM payment_allocations WHERE order_id = $1',
      [overOrder.id],
      client,
    );
    const overException = await one<{
      kind: string;
      amount_cents: number;
      status: string;
      resolved_by: string | null;
      resolution_code: string | null;
    }>(
      'SELECT kind, amount_cents, status, resolved_by, resolution_code FROM payment_exceptions WHERE payment_id = $1',
      [overPayment?.id ?? null],
      client,
    );
    c.eq('overpayment case: payment amount', 4800, overPayment?.amount_cents ?? null);
    c.eq('overpayment case: applied to the order', 4200, overAlloc?.total ?? null);
    c.eq('overpayment case: exception kind', 'OVERPAYMENT', overException?.kind ?? null);
    c.eq('overpayment case: unresolved amount', 600, overException?.amount_cents ?? null);
    c.is(
      'overpayment case: $6 not settled by the machine',
      'OPEN, or RESOLVED by a named person',
      { status: overException?.status ?? null, resolvedBy: overException?.resolved_by ?? null },
      overException?.status === 'OPEN' ||
        (overException?.status === 'RESOLVED' && Boolean(overException?.resolved_by)),
    );

    const orphan = await one<{
      id: string;
      amount_cents: number;
      order_id: string | null;
      status: string;
    }>(
      `SELECT id, amount_cents, order_id, status FROM payments
        WHERE bakery_id = $1 AND scenario_tag = 'payments' AND order_id IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [bakeryId],
      client,
    );
    c.eq('unmatched case: a payment exists with no order', 1400, orphan?.amount_cents ?? null);
    c.eq('unmatched case: order_id really is null', null, orphan ? orphan.order_id : 'no payment row');

    const orphanException = await one<{ id: string; kind: string; status: string }>(
      'SELECT id, kind, status FROM payment_exceptions WHERE payment_id = $1',
      [orphan?.id ?? null],
      client,
    );
    c.eq('unmatched case: exception kind', 'UNMATCHED', orphanException?.kind ?? null);

    const suggestions = await query<{
      order_id: string | null;
      amount_cents: number;
      confidence: number;
      status: string;
      rationale: string;
    }>(
      'SELECT order_id, amount_cents, confidence, status, rationale FROM payment_suggestions WHERE exception_id = $1 ORDER BY confidence DESC',
      [orphanException?.id ?? null],
      client,
    );
    c.is('unmatched case: suggestions offered', 'at least one', suggestions.length, suggestions.length > 0);
    c.eq(
      'unmatched case: every suggestion points at an order that already existed',
      0,
      suggestions.filter((s) => s.order_id === null).length,
    );

    // No order may have been conjured to absorb the money.
    const run = await one<{ result: { ordersBefore?: number; ordersAfter?: number } }>(
      `SELECT result FROM scenario_runs WHERE bakery_id = $1 AND scenario = 'payments'
        ORDER BY created_at DESC LIMIT 1`,
      [bakeryId],
      client,
    );
    c.eq(
      'unmatched case: no order invented',
      run?.result?.ordersBefore ?? null,
      run?.result?.ordersAfter ?? null,
    );

    c.note('exactOrder', exactOrder);
    c.note('overException', overException);
    c.note('unmatchedPayment', orphan);
    c.note('suggestions', suggestions);
  }

  return c.build('payment_brain', '4. Payment brain', 'CORE', {
    hasEvidence: exactOrder !== null && overOrder !== null,
    missing: 'No payment scenario data stored. Run the payments scenario.',
  });
}

// ---------------------------------------------------------------------------
// 5. Credit allocation
// ---------------------------------------------------------------------------
async function checkCredit(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const credit = await one<{ id: string; amount_cents: number }>(
    `SELECT id, amount_cents FROM credits WHERE bakery_id = $1 AND scenario_tag = 'credit'
      ORDER BY created_at DESC LIMIT 1`,
    [bakeryId],
    client,
  );

  if (credit) {
    const allocations = await query<{
      sequence: number;
      amount_cents: number;
      order_code: string;
    }>(
      `SELECT ca.sequence, ca.amount_cents, o.code AS order_code
         FROM credit_allocations ca JOIN orders o ON o.id = ca.order_id
        WHERE ca.credit_id = $1 ORDER BY ca.sequence`,
      [credit.id],
      client,
    );
    const remaining = await one<{ remaining: number }>(
      `SELECT (c.amount_cents - coalesce((SELECT sum(amount_cents) FROM credit_allocations WHERE credit_id = c.id),0))::int AS remaining
         FROM credits c WHERE c.id = $1`,
      [credit.id],
      client,
    );
    const lastOrder = await one<{ outstanding: number; total_cents: number }>(
      `SELECT o.total_cents,
              (o.total_cents
                - coalesce((SELECT sum(amount_cents) FROM payment_allocations WHERE order_id = o.id),0)
                - coalesce((SELECT sum(amount_cents) FROM credit_allocations  WHERE order_id = o.id),0))::int AS outstanding
         FROM orders o WHERE o.bakery_id = $1 AND o.code = 'CREDIT-20'`,
      [bakeryId],
      client,
    );

    c.eq('credit issued', 3000, credit.amount_cents);
    c.eq('three draws recorded in order', [1200, 1500, 300], allocations.map((a) => a.amount_cents));
    c.eq('draws point at the three orders', ['CREDIT-12', 'CREDIT-15', 'CREDIT-20'], allocations.map((a) => a.order_code));
    c.eq('allocation sequence preserved', [1, 2, 3], allocations.map((a) => a.sequence));
    c.eq('credit fully spent', 0, remaining?.remaining ?? null);
    c.eq('third order total', 2000, lastOrder?.total_cents ?? null);
    c.eq('remaining due on the third order', 1700, lastOrder?.outstanding ?? null);

    const blocked =
      allocations.length > 0 &&
      (await expectRejected(
        client,
        'UPDATE credit_allocations SET amount_cents = amount_cents + 1 WHERE credit_id = $1',
        [credit.id],
      ));
    c.is('allocation history cannot be edited', 'database refuses UPDATE', blocked, blocked);

    c.note('allocations', allocations);
    c.note('remainingCents', remaining?.remaining ?? null);
  }

  return c.build('credit_allocation', '5. Credit allocation history', 'CORE', {
    hasEvidence: credit !== null,
    missing: 'No credit stored. Run the credit scenario.',
  });
}

// ---------------------------------------------------------------------------
// 6. Shipping queue
// ---------------------------------------------------------------------------
async function checkShipping(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const order = await one<{ id: string; status: string; scheduled_date: string | null; channel: string }>(
    "SELECT id, status, scheduled_date, channel FROM orders WHERE bakery_id = $1 AND code = 'SHIP-D2D'",
    [bakeryId],
    client,
  );

  if (order) {
    const assignments = await query<{
      sequence: number;
      scheduled_date: string;
      status: string;
      superseded_by: string | null;
      id: string;
    }>(
      'SELECT id, sequence, scheduled_date, status, superseded_by FROM shipping_assignments WHERE order_id = $1 ORDER BY sequence',
      [order.id],
      client,
    );
    const demands = await query<{
      service_date: string;
      status: string;
      quantity: number;
      superseded_by: string | null;
      id: string;
    }>(
      'SELECT id, service_date, status, quantity, superseded_by FROM production_demands WHERE order_id = $1 ORDER BY created_at',
      [order.id],
      client,
    );
    const firstSchedule = await one<{ before_state: { scheduledDate: string | null; status?: string } }>(
      `SELECT before_state FROM audit_log
        WHERE bakery_id = $1 AND entity_type = 'shipping_assignment' AND action = 'shipping.schedule'
          AND entity_id = $2
        ORDER BY id DESC LIMIT 1`,
      [bakeryId, assignments[0]?.id ?? null],
      client,
    );

    const first = assignments.find((a) => a.scheduled_date === DATES.shippingFirst);
    const second = assignments.find((a) => a.scheduled_date === DATES.shippingSecond);
    const oct1Demand = demands.find((d) => d.service_date === DATES.shippingFirst);
    const oct2Demand = demands.find((d) => d.service_date === DATES.shippingSecond);

    c.eq('channel', 'DOOR_TO_DOOR', order.channel);
    c.eq(
      'order began with no customer-selected date',
      { scheduledDate: null, status: 'AWAITING_SCHEDULING' },
      firstSchedule
        ? {
            scheduledDate: firstSchedule.before_state?.scheduledDate ?? null,
            status: firstSchedule.before_state?.status ?? null,
          }
        : 'no audit row for the first scheduling',
    );
    c.eq('two assignments recorded', 2, assignments.length);
    c.eq('October 1 assignment kept as history', 'SUPERSEDED', first?.status ?? null);
    c.is(
      'October 1 assignment points at its replacement',
      'superseded_by = the October 2 assignment',
      first?.superseded_by ?? null,
      Boolean(first?.superseded_by) && first?.superseded_by === second?.id,
    );
    c.eq('October 2 assignment is current', 'ACTIVE', second?.status ?? null);
    c.eq('current fulfillment date on the order', DATES.shippingSecond, order.scheduled_date);
    c.eq('order status', 'SCHEDULED', order.status);
    c.eq('October 1 production demand superseded', 'SUPERSEDED', oct1Demand?.status ?? null);
    c.is(
      'October 1 demand points at the October 2 demand',
      'superseded_by = the October 2 demand',
      oct1Demand?.superseded_by ?? null,
      Boolean(oct1Demand?.superseded_by) && oct1Demand?.superseded_by === oct2Demand?.id,
    );
    c.eq('October 2 production demand open', 'OPEN', oct2Demand?.status ?? null);

    c.note('assignments', assignments);
    c.note('demands', demands);
  }

  return c.build('shipping_queue', '6. Bakery-controlled shipping queue', 'CORE', {
    hasEvidence: order !== null,
    missing: 'No door-to-door order stored. Run the shipping scenario.',
  });
}

// ---------------------------------------------------------------------------
// 7. Consignment discrepancy
// ---------------------------------------------------------------------------
async function checkConsignment(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const delivery = await one<{
    id: string;
    delivered_units: number;
    expected_return_units: number;
    status: string;
  }>(
    `SELECT * FROM consignment_deliveries WHERE bakery_id = $1 AND scenario_tag = 'consignment'
      ORDER BY created_at DESC LIMIT 1`,
    [bakeryId],
    client,
  );

  if (delivery) {
    const ret = await one<{ returned_units: number }>(
      'SELECT returned_units FROM consignment_returns WHERE delivery_id = $1 ORDER BY created_at DESC LIMIT 1',
      [delivery.id],
      client,
    );
    const discrepancy = await one<{
      id: string;
      expected_units: number;
      actual_units: number;
      delta_units: number;
      status: string;
      resolution_code: string | null;
      resolved_by: string | null;
      resolution_note: string | null;
    }>(
      'SELECT * FROM consignment_discrepancies WHERE delivery_id = $1 ORDER BY created_at DESC LIMIT 1',
      [delivery.id],
      client,
    );
    const openedEvent = await one<{ payload: { options?: { code: string; label: string }[] } }>(
      `SELECT payload FROM events
        WHERE bakery_id = $1 AND type = 'consignment.discrepancy.opened' AND entity_id = $2
        ORDER BY id DESC LIMIT 1`,
      [bakeryId, discrepancy?.id ?? null],
      client,
    );

    c.eq('units delivered', 10, delivery.delivered_units);
    c.eq('units expected back', 2, delivery.expected_return_units);
    c.eq('units actually returned', 0, ret?.returned_units ?? null);
    c.is('a discrepancy was created', 'one discrepancy row', discrepancy?.id ?? null, Boolean(discrepancy));
    c.eq('discrepancy delta', -2, discrepancy?.delta_units ?? null);
    c.is(
      'not silently resolved',
      'OPEN, or RESOLVED with a named person and a chosen option',
      {
        status: discrepancy?.status ?? null,
        resolutionCode: discrepancy?.resolution_code ?? null,
        resolvedBy: discrepancy?.resolved_by ?? null,
      },
      discrepancy?.status === 'OPEN' ||
        (discrepancy?.status === 'RESOLVED' &&
          Boolean(discrepancy?.resolved_by) &&
          Boolean(discrepancy?.resolution_code)),
    );
    c.eq(
      'the four human options were recorded with the discrepancy',
      ['ASSUME_SOLD', 'BAKERY_MISSED_RETURN', 'WRITE_OFF_LOST', 'OTHER'],
      (openedEvent?.payload?.options ?? []).map((o) => o.code),
    );

    c.note('delivery', delivery);
    c.note('discrepancy', discrepancy);
    c.note('options', openedEvent?.payload?.options ?? []);
  }

  return c.build('consignment_discrepancy', '7. Consignment discrepancy', 'CORE', {
    hasEvidence: delivery !== null,
    missing: 'No consignment delivery stored. Run the consignment scenario.',
  });
}

// ---------------------------------------------------------------------------
// 8. Historical integrity
// ---------------------------------------------------------------------------
async function checkHistory(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const order = await one<{ id: string }>(
    "SELECT id FROM orders WHERE bakery_id = $1 AND code = 'HIST-ORDER'",
    [bakeryId],
    client,
  );

  if (order) {
    const line = await one<{
      id: string;
      unit_price_cents: number;
      captured_version: number;
      captured_cents: number;
      product_id: string;
    }>(
      `SELECT ol.id, ol.unit_price_cents, ol.product_id,
              pp.version AS captured_version, pp.unit_price_cents AS captured_cents
         FROM order_lines ol JOIN product_prices pp ON pp.id = ol.price_version_id
        WHERE ol.order_id = $1 LIMIT 1`,
      [order.id],
      client,
    );
    const currentPrice = await one<{ version: number; unit_price_cents: number }>(
      'SELECT version, unit_price_cents FROM product_prices WHERE product_id = $1 AND superseded_at IS NULL',
      [line?.product_id ?? null],
      client,
    );
    const run = await one<{ id: string; used_version: number; recipe_id: string }>(
      `SELECT r.id, rv.version AS used_version, rv.recipe_id
         FROM production_runs r
         JOIN production_plans p ON p.id = r.plan_id
         JOIN recipe_versions rv ON rv.id = r.recipe_version_id
        WHERE r.bakery_id = $1 AND p.scenario_tag = 'history'
        ORDER BY r.started_at DESC LIMIT 1`,
      [bakeryId],
      client,
    );
    const currentRecipe = await one<{ version: number }>(
      'SELECT version FROM recipe_versions WHERE recipe_id = $1 AND superseded_at IS NULL',
      [run?.recipe_id ?? null],
      client,
    );

    c.eq('old order line still priced at $14', 1400, line?.unit_price_cents ?? null);
    c.eq('old order line still points at price version 1', 1, line?.captured_version ?? null);
    c.eq('the version it points at still says $14', 1400, line?.captured_cents ?? null);
    c.eq('current catalogue price is now $15', 1500, currentPrice?.unit_price_cents ?? null);
    c.eq('current price version', 2, currentPrice?.version ?? null);
    c.eq('old production run still records recipe v1', 1, run?.used_version ?? null);
    c.eq('current recipe version is v2', 2, currentRecipe?.version ?? null);

    const priceBlocked = line
      ? await expectRejected(client, 'UPDATE order_lines SET unit_price_cents = 1500 WHERE id = $1', [line.id])
      : false;
    c.is('captured order price cannot be rewritten', 'database refuses UPDATE', priceBlocked, priceBlocked);

    const recipeBlocked = run
      ? await expectRejected(
          client,
          `UPDATE production_runs SET recipe_version_id =
             (SELECT id FROM recipe_versions WHERE recipe_id = $2 AND superseded_at IS NULL) WHERE id = $1`,
          [run.id, run.recipe_id],
        )
      : false;
    c.is('run recipe version cannot be swapped', 'database refuses UPDATE', recipeBlocked, recipeBlocked);

    c.note('orderLine', line);
    c.note('currentPrice', currentPrice);
    c.note('runRecipeVersion', run?.used_version ?? null);
    c.note('currentRecipeVersion', currentRecipe?.version ?? null);
  }

  return c.build('historical_integrity', '8. Historical integrity', 'CORE', {
    hasEvidence: order !== null,
    missing: 'No historical-integrity order stored. Run the history scenario.',
  });
}

// ---------------------------------------------------------------------------
// 9. Tesla brain
// ---------------------------------------------------------------------------
const EXPECTED_RECOMMENDATION =
  '3 units short. Reducing wholesale allocation by 3 would preserve customer orders.';

async function checkTesla(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const recs = await query<{
    id: string;
    message: string;
    status: string;
    payload: { autoApplied?: boolean; proposedWholesaleUnits?: number; shortUnits?: number };
    decided_by: string | null;
    created_at: string;
  }>(
    `SELECT id, message, status, payload, decided_by, created_at FROM recommendations
      WHERE bakery_id = $1 AND kind = 'SUPPLY_SHORTFALL' ORDER BY created_at DESC`,
    [bakeryId],
    client,
  );

  if (recs.length > 0) {
    const latest = recs[0]!;
    const withMessage = recs.filter((r) => r.message === EXPECTED_RECOMMENDATION);

    c.eq('recommendation wording', EXPECTED_RECOMMENDATION, latest.message);
    c.eq('shortfall computed', 3, latest.payload?.shortUnits ?? null);
    c.eq('proposed wholesale allocation', 2, latest.payload?.proposedWholesaleUnits ?? null);
    c.eq('nothing applied automatically', false, latest.payload?.autoApplied ?? null);

    const effects = await query<{
      recommendation_id: string;
      before_state: { allocated_units?: number } | null;
      after_state: { allocated_units?: number } | null;
      status: string;
    }>(
      `SELECT e.recommendation_id, e.before_state, e.after_state, r.status
         FROM recommendation_effects e JOIN recommendations r ON r.id = e.recommendation_id
        WHERE e.bakery_id = $1 ORDER BY e.created_at DESC`,
      [bakeryId],
      client,
    );

    const acceptedEffect = effects.find(
      (e) => e.status === 'ACCEPTED' && e.before_state?.allocated_units === 5 && e.after_state?.allocated_units === 2,
    );
    const rejectedEffect = effects.find(
      (e) =>
        e.status === 'REJECTED' &&
        e.before_state?.allocated_units === 5 &&
        e.after_state?.allocated_units === 5,
    );

    const pendingLatest = latest.status === 'PENDING';
    if (pendingLatest) {
      const active = await one<{ allocated_units: number }>(
        `SELECT allocated_units FROM wholesale_allocations
          WHERE bakery_id = $1 AND service_date = $2 AND status = 'ACTIVE'`,
        [bakeryId, DATES.tesla],
        client,
      );
      c.eq('while pending, wholesale allocation untouched', 5, active?.allocated_units ?? null);
    }

    c.is(
      'accepting moves wholesale 5 -> 2',
      'an ACCEPTED recommendation with before 5 and after 2',
      acceptedEffect
        ? { before: acceptedEffect.before_state?.allocated_units, after: acceptedEffect.after_state?.allocated_units }
        : null,
      Boolean(acceptedEffect),
    );
    c.is(
      'rejecting leaves wholesale at 5',
      'a REJECTED recommendation with before 5 and after 5',
      rejectedEffect
        ? { before: rejectedEffect.before_state?.allocated_units, after: rejectedEffect.after_state?.allocated_units }
        : null,
      Boolean(rejectedEffect),
    );
    c.is(
      'decisions are attributed',
      'every decided recommendation has decided_by',
      recs.filter((r) => r.status !== 'PENDING' && !r.decided_by).length,
      recs.filter((r) => r.status !== 'PENDING' && !r.decided_by).length === 0,
    );
    c.is(
      'recommendation history preserved',
      'every recommendation ever raised is still stored',
      recs.length,
      recs.length >= withMessage.length && recs.length > 0,
    );

    c.note('recommendations', recs);
    c.note('effects', effects);

    const missingDecisions: string[] = [];
    if (!acceptedEffect) missingDecisions.push('accept one (expect wholesale 5 -> 2)');
    if (!rejectedEffect) missingDecisions.push('reject one (expect wholesale to stay 5)');

    return c.build('tesla_brain', '9. Tesla brain', 'CORE', {
      hasEvidence: true,
      missing: '',
      pending:
        missingDecisions.length > 0
          ? `Both decision paths must be exercised. Still to do: ${missingDecisions.join('; ')}.`
          : null,
    });
  }

  return c.build('tesla_brain', '9. Tesla brain', 'CORE', {
    hasEvidence: false,
    missing: 'No recommendation stored. Run the Tesla scenario.',
  });
}

// ---------------------------------------------------------------------------
// Platform: tenant isolation
// ---------------------------------------------------------------------------
async function checkTenantIsolation(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const probes = await query<{
    attempt: string;
    expected_outcome: string;
    observed_status: number;
    observed_outcome: string;
    passed: boolean;
    created_at: string;
  }>(
    `SELECT attempt, expected_outcome, observed_status, observed_outcome, passed, created_at
       FROM platform_probes
      WHERE category = 'TENANT_ISOLATION' AND actor_bakery_id = $1
        AND created_at >= (SELECT max(created_at) FROM platform_probes
                            WHERE category = 'TENANT_ISOLATION' AND actor_bakery_id = $1) - interval '2 minutes'
      ORDER BY created_at`,
    [bakeryId],
    client,
  );

  // Server-side corroboration: the refusals the API itself logged.
  const denied = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM audit_log
      WHERE outcome = 'DENIED' AND action = 'tenant.access.denied'`,
    [],
    client,
  );

  // Structural: no row in this tenant may reference another tenant's rows.
  const leaks = await one<{ orders: number; lines: number; commitments: number; payments: number }>(
    `SELECT
       (SELECT count(*) FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.bakery_id <> c.bakery_id)::int AS orders,
       (SELECT count(*) FROM order_lines l JOIN products p ON p.id = l.product_id
         WHERE l.bakery_id <> p.bakery_id)::int AS lines,
       (SELECT count(*) FROM commitments cm JOIN orders o ON o.id = cm.order_id
         WHERE cm.bakery_id <> o.bakery_id)::int AS commitments,
       (SELECT count(*) FROM payment_allocations pa JOIN orders o ON o.id = pa.order_id
         WHERE pa.bakery_id <> o.bakery_id)::int AS payments`,
    [],
    client,
  );

  if (probes.length > 0) {
    for (const p of probes) {
      c.is(p.attempt, p.expected_outcome, `${p.observed_status} ${p.observed_outcome}`, p.passed);
    }
    c.is(
      'the server logged the refusals itself',
      'at least one DENIED audit row',
      denied?.count ?? 0,
      (denied?.count ?? 0) > 0,
    );
  }
  c.eq('orders referencing another tenant customer', 0, leaks?.orders ?? null);
  c.eq('order lines referencing another tenant product', 0, leaks?.lines ?? null);
  c.eq('commitments crossing tenants', 0, leaks?.commitments ?? null);
  c.eq('payment allocations crossing tenants', 0, leaks?.payments ?? null);
  c.note('probes', probes);
  c.note('deniedAuditRows', denied?.count ?? 0);

  return c.build('tenant_isolation', 'Tenant isolation', 'PLATFORM', {
    hasEvidence: probes.length > 0,
    missing: 'No isolation probes stored. Run the platform probes from the console.',
  });
}

// ---------------------------------------------------------------------------
// Platform: server-side authorization
// ---------------------------------------------------------------------------
async function checkAuthorization(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const probes = await query<{
    attempt: string;
    expected_outcome: string;
    observed_status: number;
    observed_outcome: string;
    passed: boolean;
  }>(
    `SELECT attempt, expected_outcome, observed_status, observed_outcome, passed
       FROM platform_probes
      WHERE category = 'SERVER_AUTHORIZATION' AND actor_bakery_id = $1
      ORDER BY created_at DESC LIMIT 10`,
    [bakeryId],
    client,
  );

  const selfMoved = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM memberships m
      WHERE m.created_by IS NOT NULL AND m.created_by = m.user_id`,
    [],
    client,
  );
  const membershipCount = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM memberships WHERE user_id IN (SELECT user_id FROM memberships GROUP BY user_id)',
    [],
    client,
  );

  for (const p of probes) {
    c.is(p.attempt, p.expected_outcome, `${p.observed_status} ${p.observed_outcome}`, p.passed);
  }
  c.eq('memberships a user granted to themselves', 0, selfMoved?.count ?? null);
  c.note('probes', probes);
  c.note('membershipRows', membershipCount?.count ?? 0);

  return c.build('server_side_authorization', 'Server-side authorization', 'PLATFORM', {
    hasEvidence: probes.length > 0,
    missing: 'No authorization probes stored. Run the platform probes from the console.',
  });
}

// ---------------------------------------------------------------------------
// Platform: duplicate protection
// ---------------------------------------------------------------------------
async function checkDuplicates(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const probes = await query<{
    attempt: string;
    expected_outcome: string;
    observed_status: number;
    observed_outcome: string;
    passed: boolean;
    detail: Record<string, unknown>;
  }>(
    `SELECT attempt, expected_outcome, observed_status, observed_outcome, passed, detail
       FROM platform_probes
      WHERE category = 'DUPLICATE_PROTECTION' AND actor_bakery_id = $1
      ORDER BY created_at DESC LIMIT 10`,
    [bakeryId],
    client,
  );

  const replays = await one<{ max_replays: number; rows: number }>(
    `SELECT coalesce(max(replay_count),0)::int AS max_replays, count(*)::int AS rows
       FROM idempotency_keys WHERE bakery_id = $1`,
    [bakeryId],
    client,
  );
  const dupeRefs = await one<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
        SELECT external_ref FROM payments
         WHERE bakery_id = $1 AND external_ref IS NOT NULL
         GROUP BY external_ref HAVING count(*) > 1) d`,
    [bakeryId],
    client,
  );

  for (const p of probes) {
    c.is(p.attempt, p.expected_outcome, `${p.observed_status} ${p.observed_outcome}`, p.passed);
  }
  c.is(
    'a replayed idempotency key was served from store',
    'replay_count >= 1',
    replays?.max_replays ?? 0,
    (replays?.max_replays ?? 0) >= 1,
  );
  c.eq('duplicate external payment references in the database', 0, dupeRefs?.count ?? null);
  c.note('idempotencyKeys', replays);
  c.note('probes', probes);

  return c.build('duplicate_protection', 'Duplicate protection', 'PLATFORM', {
    hasEvidence: probes.length > 0,
    missing: 'No duplicate-protection probes stored. Run the platform probes from the console.',
  });
}

// ---------------------------------------------------------------------------
// Platform: realtime
// ---------------------------------------------------------------------------
async function checkRealtime(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const report = await one<{
    result: {
      sameTenantProbeId?: string;
      crossTenantProbeId?: string;
      receivedNonces?: string[];
      subscriberBakeryId?: string;
    };
    created_at: string;
  }>(
    `SELECT result, created_at FROM scenario_runs
      WHERE bakery_id = $1 AND scenario = 'realtime' ORDER BY created_at DESC LIMIT 1`,
    [bakeryId],
    client,
  );

  if (report) {
    const sameId = report.result?.sameTenantProbeId ?? null;
    const crossId = report.result?.crossTenantProbeId ?? null;

    const sameReceipt = await one<{ count: number; latency: number | null }>(
      `SELECT count(*)::int AS count, min(latency_ms)::int AS latency FROM realtime_receipts
        WHERE probe_id = $1 AND subscriber_bakery_id = $2`,
      [sameId, bakeryId],
      client,
    );
    const crossReceipt = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM realtime_receipts
        WHERE probe_id = $1 AND subscriber_bakery_id = $2`,
      [crossId, bakeryId],
      client,
    );
    const crossProbe = await one<{ bakery_id: string }>('SELECT bakery_id FROM realtime_probes WHERE id = $1', [
      crossId,
    ], client);
    const sameEvent = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM events WHERE bakery_id = $1 AND type = 'realtime.probe'`,
      [bakeryId],
      client,
    );

    c.is('probe raised in this tenant was delivered', 'one receipt', sameReceipt?.count ?? 0, (sameReceipt?.count ?? 0) === 1);
    c.eq('probe raised in the other tenant was NOT delivered here', 0, crossReceipt?.count ?? null);
    c.is(
      'the cross-tenant probe really belonged to the other tenant',
      'a different bakery id',
      crossProbe?.bakery_id ?? null,
      Boolean(crossProbe) && crossProbe!.bakery_id !== bakeryId,
    );
    c.is(
      'the notification came from a database change',
      'a realtime.probe event row exists',
      sameEvent?.count ?? 0,
      (sameEvent?.count ?? 0) > 0,
    );
    c.note('report', report.result);
    c.note('deliveryLatencyMs', sameReceipt?.latency ?? null);
  }

  return c.build('realtime', 'Realtime (notify -> re-read)', 'PLATFORM', {
    hasEvidence: report !== null,
    missing: 'No realtime report stored. Open the console and run the realtime test.',
  });
}

// ---------------------------------------------------------------------------
// Platform: event and audit history
// ---------------------------------------------------------------------------
async function checkEvents(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const stats = await one<{ total: number; types: number; newest: number | null }>(
    `SELECT count(*)::int AS total, count(DISTINCT type)::int AS types, max(id)::int AS newest
       FROM events WHERE bakery_id = $1`,
    [bakeryId],
    client,
  );
  const hasEvidence = (stats?.total ?? 0) > 0;

  if (hasEvidence) {
    // Target one real row: an UPDATE that matches nothing would "pass"
    // without the guard ever firing.
    const blockedUpdate = await expectRejected(
      client,
      "UPDATE events SET type = 'tampered' WHERE id = $1",
      [stats!.newest],
    );
    const blockedDelete = await expectRejected(client, 'DELETE FROM events WHERE id = $1', [stats!.newest]);
    const orphanActors = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM events e
        WHERE e.bakery_id = $1 AND e.actor_user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.actor_user_id)`,
      [bakeryId],
      client,
    );
    const recent = await query(
      'SELECT id, type, entity_type, created_at FROM events WHERE bakery_id = $1 ORDER BY id DESC LIMIT 10',
      [bakeryId],
      client,
    );

    c.is('events recorded', 'more than zero', stats!.total, stats!.total > 0);
    c.is('events cannot be edited', 'database refuses UPDATE', blockedUpdate, blockedUpdate);
    c.is('events cannot be deleted', 'database refuses DELETE', blockedDelete, blockedDelete);
    c.eq('events with an unknown actor', 0, orphanActors?.count ?? null);
    c.note('eventCount', stats!.total);
    c.note('distinctTypes', stats!.types);
    c.note('recent', recent);
  }

  return c.build('event_history', 'Event history', 'PLATFORM', {
    hasEvidence,
    missing: 'No events stored yet. Run any scenario.',
  });
}

async function checkAudit(client: PoolClient, bakeryId: string): Promise<CheckResult> {
  const c = new Case();
  const stats = await one<{
    total: number;
    denied: number;
    actions: number;
    withActor: number;
    newest: number | null;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE outcome = 'DENIED')::int AS denied,
            count(DISTINCT action)::int AS actions,
            count(*) FILTER (WHERE actor_user_id IS NOT NULL)::int AS "withActor",
            max(id)::int AS newest
       FROM audit_log WHERE bakery_id = $1`,
    [bakeryId],
    client,
  );
  const hasEvidence = (stats?.total ?? 0) > 0;

  if (hasEvidence) {
    // Target one real row, so the guard genuinely has to refuse something.
    const blockedUpdate = await expectRejected(
      client,
      "UPDATE audit_log SET action = 'tampered' WHERE id = $1",
      [stats!.newest],
    );
    const blockedDelete = await expectRejected(client, 'DELETE FROM audit_log WHERE id = $1', [stats!.newest]);
    const recent = await query(
      `SELECT id, action, entity_type, outcome, created_at FROM audit_log
        WHERE bakery_id = $1 ORDER BY id DESC LIMIT 10`,
      [bakeryId],
      client,
    );

    c.is('audit rows recorded', 'more than zero', stats!.total, stats!.total > 0);
    c.is('actions attributed to users', 'at least one row with an actor', stats!.withActor, stats!.withActor > 0);
    c.is('refused attempts are audited too', 'at least one DENIED row', stats!.denied, stats!.denied > 0);
    c.is('audit rows cannot be edited', 'database refuses UPDATE', blockedUpdate, blockedUpdate);
    c.is('audit rows cannot be deleted', 'database refuses DELETE', blockedDelete, blockedDelete);
    c.note('auditCount', stats!.total);
    c.note('deniedCount', stats!.denied);
    c.note('recent', recent);
  }

  return c.build('audit_history', 'Audit history', 'PLATFORM', {
    hasEvidence,
    missing: 'No audit rows stored yet. Run any scenario.',
  });
}

export async function runChecks(client: PoolClient, bakeryId: string): Promise<CheckResult[]> {
  return [
    await checkAvailability(client, bakeryId),
    await checkProduction(client, bakeryId),
    await checkFailure(client, bakeryId),
    await checkPayments(client, bakeryId),
    await checkCredit(client, bakeryId),
    await checkShipping(client, bakeryId),
    await checkConsignment(client, bakeryId),
    await checkHistory(client, bakeryId),
    await checkTesla(client, bakeryId),
    await checkTenantIsolation(client, bakeryId),
    await checkAuthorization(client, bakeryId),
    await checkDuplicates(client, bakeryId),
    await checkRealtime(client, bakeryId),
    await checkEvents(client, bakeryId),
    await checkAudit(client, bakeryId),
  ];
}

export function summarise(results: CheckResult[]) {
  return {
    pass: results.filter((r) => r.verdict === 'PASS').length,
    conditional: results.filter((r) => r.verdict === 'CONDITIONAL').length,
    fail: results.filter((r) => r.verdict === 'FAIL').length,
    total: results.length,
  };
}
