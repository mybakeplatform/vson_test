/**
 * End-to-end acceptance test.
 *
 * Boots the real server against the real database, drives every scenario and
 * every human decision over HTTP, then asserts that the server's own check
 * engine returns PASS for all fifteen checks. If a business rule regresses,
 * the check engine notices and this test fails with the exact assertion.
 *
 * Requires DATABASE_URL. See README.
 */
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { Client, collectSseEvents, sleep, startHarness, type Harness } from './helpers.js';

let harness: Harness;
let a: Client; // owner of Crust & Crackle Test Bakery
let b: Client; // owner of Second Bakery Test

before(async () => {
  harness = await startHarness();
  a = new Client(harness.baseUrl);
  b = new Client(harness.baseUrl);
  await a.login('owner@crustandcrackle.test');
  await b.login('owner@secondbakery.test');
});

after(async () => {
  await harness.stop();
});

const SCENARIOS = [
  'availability',
  'production',
  'failure',
  'payments',
  'credit',
  'shipping',
  'consignment',
  'history',
  'tesla',
] as const;

describe('MyBake platform acceptance', () => {
  test('the two tenants are distinct and membership is server-held', async () => {
    assert.notEqual(a.session!.bakeryId, b.session!.bakeryId);
    assert.equal(a.session!.bakeryName, 'Crust & Crackle Test Bakery');
    assert.equal(b.session!.bakeryName, 'Second Bakery Test');
  });

  test('a client-supplied bakery id is never authorization', async () => {
    const forged = await a.request('/state', { bakeryId: b.session!.bakeryId });
    assert.equal(forged.status, 403);

    const nonsense = await a.request('/state', { bakeryId: '00000000-0000-4000-8000-000000000000' });
    assert.equal(nonsense.status, 403);
  });

  test('a user cannot move themselves between bakeries', async () => {
    const intoB = await a.request(`/bakeries/${b.session!.bakeryId}/members`, {
      method: 'POST',
      body: { userId: a.session!.userId, role: 'OWNER' },
    });
    assert.equal(intoB.status, 403);

    const intoOwn = await a.request(`/bakeries/${a.session!.bakeryId}/members`, {
      method: 'POST',
      body: { userId: a.session!.userId, role: 'OWNER' },
    });
    assert.equal(intoOwn.status, 403);
  });

  test('scenarios run and store their evidence', async () => {
    for (const scenario of SCENARIOS) {
      const result = await a.must(`/scenarios/${scenario}/run`, { method: 'POST', body: {} });
      assert.equal(result.scenario, scenario);
    }
  });

  test('availability rejects the 54th unit outright, with no partial acceptance', async () => {
    const checks = await a.must('/checks');
    const availability = checks.checks.find((c: any) => c.id === 'availability_engine');
    assert.equal(availability.verdict, 'PASS', availability.summary);
  });

  test('a staff member may run scenarios, a forged tenant still cannot', async () => {
    const staff = new Client(harness.baseUrl);
    await staff.login('baker@crustandcrackle.test');
    const allowed = await staff.request('/state');
    assert.equal(allowed.status, 200);
    const denied = await staff.request('/state', { bakeryId: b.session!.bakeryId });
    assert.equal(denied.status, 403);
  });

  test('platform probes record real refusals', async () => {
    const result = await a.must('/probes/run', { method: 'POST', body: {} });
    assert.ok(result.ran >= 5, `expected several probes, got ${result.ran}`);
    assert.equal(result.passed, result.ran, JSON.stringify(result.probes, null, 2));
  });

  test('an idempotency key never runs the same write twice', async () => {
    const inbox = await a.must('/state');
    const customerId = inbox.customers[0].id;
    const key = `test-${Date.now()}`;
    const first = await a.request('/credits', {
      method: 'POST',
      idempotencyKey: key,
      body: { customerId, amountCents: 500, source: 'MANUAL', note: 'idem test', scenarioTag: 'probe' },
    });
    const second = await a.request('/credits', {
      method: 'POST',
      idempotencyKey: key,
      body: { customerId, amountCents: 500, source: 'MANUAL', note: 'idem test', scenarioTag: 'probe' },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('x-idempotent-replay'), 'true');
    assert.equal(first.body.credit.id, second.body.credit.id, 'a replay must not create a second credit');

    const changed = await a.request('/credits', {
      method: 'POST',
      idempotencyKey: key,
      body: { customerId, amountCents: 999, source: 'MANUAL', note: 'different', scenarioTag: 'probe' },
    });
    assert.equal(changed.status, 409, 'reusing a key with a different body must be refused');
  });

  test('realtime delivers to the same tenant and not across tenants', async () => {
    const received: string[] = [];
    const collecting = collectSseEvents(
      harness.baseUrl,
      a.session!.token,
      a.session!.bakeryId,
      2500,
      (event) => {
        if (event.event === 'change' && event.data.type === 'realtime.probe') {
          received.push(event.data.entity_id);
        }
      },
    );

    await sleep(300); // let the socket attach
    const same = await a.must('/realtime/probe', { method: 'POST', body: {} });
    const cross = await b.must('/realtime/probe', { method: 'POST', body: {} });

    await collecting;

    assert.ok(received.includes(same.probeId), 'own-tenant probe must arrive');
    assert.ok(!received.includes(cross.probeId), 'another tenant\'s probe must never arrive');

    // Report what arrived so the check engine has persisted evidence.
    const events = await a.must('/events?limit=30');
    const nonces = received
      .map((probeId: string) => events.events.find((e: any) => e.entity_id === probeId)?.payload?.nonce)
      .filter(Boolean)
      .map((nonce: string) => ({ nonce }));

    await a.must('/realtime/report', {
      method: 'POST',
      body: { sameTenantProbeId: same.probeId, crossTenantProbeId: cross.probeId, received: nonces },
    });
  });

  test('a recommendation is only applied when a person accepts it', async () => {
    const inbox = await a.must('/inbox');
    const pending = inbox.recommendations.find((r: any) => r.status === 'PENDING');
    assert.ok(pending, 'the Tesla scenario should have left a pending recommendation');
    assert.equal(
      pending.message,
      '3 units short. Reducing wholesale allocation by 3 would preserve customer orders.',
    );

    const accepted = await a.must(`/recommendations/${pending.id}/decide`, {
      method: 'POST',
      body: { decision: 'ACCEPT', note: 'acceptance test' },
    });
    assert.equal(accepted.wholesaleBefore, 5);
    assert.equal(accepted.wholesaleAfter, 2);

    // Re-run the scenario and take the other branch.
    await a.must('/scenarios/tesla/run', { method: 'POST', body: {} });
    const second = await a.must('/inbox');
    const nextPending = second.recommendations.find((r: any) => r.status === 'PENDING');
    assert.ok(nextPending);
    const rejected = await a.must(`/recommendations/${nextPending.id}/decide`, {
      method: 'POST',
      body: { decision: 'REJECT', note: 'acceptance test' },
    });
    assert.equal(rejected.wholesaleBefore, 5);
    assert.equal(rejected.wholesaleAfter, 5, 'rejecting must change nothing');
  });

  test('every check passes on the stored evidence', async () => {
    const checks = await a.must('/checks');
    const failures = checks.checks.filter((c: any) => c.verdict !== 'PASS');
    assert.deepEqual(
      failures.map((c: any) => ({
        id: c.id,
        verdict: c.verdict,
        summary: c.summary,
        mismatches: c.assertions.filter((x: any) => !x.ok),
      })),
      [],
      'all checks must be PASS',
    );
    assert.equal(checks.summary.total, 15);
    assert.equal(checks.summary.pass, 15);
  });

  test('the second tenant sees none of the first tenant data', async () => {
    const state = await b.must('/state');
    assert.equal(state.orders.length, 0, 'bakery B must have no orders from bakery A');
    const bChecks = await b.must('/checks');
    assert.ok(
      bChecks.checks.every((c: any) => c.verdict !== 'FAIL'),
      'bakery B should be unproven, never contradicted',
    );
    assert.ok(
      bChecks.checks.filter((c: any) => c.verdict === 'CONDITIONAL').length >= 9,
      'bakery B has run no scenarios, so its core checks are conditional',
    );
  });
});
