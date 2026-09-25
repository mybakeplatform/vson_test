/**
 * MyBake Platform Test Console.
 *
 * Deliberately plain: no framework, no build step, so the console is part of
 * the repository a developer clones rather than an artefact of a toolchain.
 *
 * The realtime contract this console follows:
 *   server pushes a pointer -> console re-reads authoritative state over HTTP.
 * Nothing on screen is ever rendered from the push payload alone.
 */

const state = {
  token: null,
  user: null,
  bakeryId: null,
  sse: null,
  probes: { same: null, cross: null, received: [] },
  listening: false,
};

const $ = (id) => document.getElementById(id);

function log(message) {
  const el = $('action-log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${message}\n${el.textContent}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (state.bakeryId) headers['X-Bakery-Id'] = state.bakeryId;
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(body?.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

const money = (cents) => (cents === null || cents === undefined ? '-' : `$${(cents / 100).toFixed(2)}`);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const show = (value) =>
  value === null || value === undefined
    ? '<span class="muted">null</span>'
    : esc(typeof value === 'object' ? JSON.stringify(value) : value);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
async function login() {
  $('login-error').textContent = '';
  try {
    const result = await api('/auth/login', {
      method: 'POST',
      body: { email: $('email').value.trim(), password: $('password').value },
    });
    state.token = result.token;
    state.user = result.user;
    state.bakeryId = result.user.memberships[0]?.bakeryId ?? null;
    localStorage.setItem('mybake.token', result.token);
    afterLogin();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
}

function afterLogin() {
  $('login-panel').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('session-status').textContent = `${state.user.displayName} <${state.user.email}>`;

  const select = $('bakery-select');
  select.hidden = false;
  select.innerHTML = state.user.memberships
    .map((m) => `<option value="${m.bakeryId}">${esc(m.bakeryName)} (${m.role})</option>`)
    .join('');
  select.value = state.bakeryId;

  openStream();
  refreshAll();
}

function logout() {
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('mybake.token');
  state.token = null;
  state.user = null;
  if (state.sse) state.sse.close();
  location.reload();
}

// ---------------------------------------------------------------------------
// Realtime: a push is a hint to re-read, never the data itself
// ---------------------------------------------------------------------------
function openStream() {
  if (state.sse) state.sse.close();
  const url = `/api/realtime/stream?access_token=${encodeURIComponent(state.token)}&bakery_id=${state.bakeryId}`;
  const sse = new EventSource(url);
  state.sse = sse;

  // `ready` arrives on EVERY open of this socket, including the automatic
  // reconnects EventSource performs after a drop. The server has re-run
  // authenticate + requireTenant by the time it is sent, so the tenant context
  // is already restored. Anything that changed while we were disconnected was
  // never pushed to us, so the only safe move is to re-read authoritative
  // state over HTTP rather than assume the feed is complete.
  sse.addEventListener('ready', (message) => {
    const wasDisconnected = !state.listening;
    state.listening = true;
    $('rt-indicator').textContent = 'realtime: connected';
    $('rt-indicator').className = 'pill pill-on';

    if (wasDisconnected) {
      let latestEventId = null;
      try {
        latestEventId = JSON.parse(message.data).latestEventId ?? null;
      } catch {
        /* the frame is a hint, not state: a missing field changes nothing */
      }
      const feed = $('rt-feed');
      const row = document.createElement('div');
      row.textContent = latestEventId
        ? `reconnected at #${latestEventId} -> refetching authoritative state`
        : 'reconnected -> refetching authoritative state';
      feed.prepend(row);
    }
    // Unconditional: a connect we believed was the first can still follow a
    // drop we never saw. scheduleRefresh debounces, so the duplicate costs
    // nothing and the stale-state window closes either way.
    scheduleRefresh();
  });

  sse.addEventListener('change', (message) => {
    const notice = JSON.parse(message.data);
    const feed = $('rt-feed');
    const row = document.createElement('div');
    row.textContent = `#${notice.event_id} ${notice.type} (${notice.entity_type}) -> re-reading state`;
    feed.prepend(row);
    while (feed.childNodes.length > 60) feed.removeChild(feed.lastChild);

    if (notice.type === 'realtime.probe') {
      // Record the receipt locally; it is reported to the server at the end
      // of the realtime test window.
      state.probes.received.push({ eventId: notice.event_id, at: Date.now() });
      fetchProbeNonce(notice.entity_id);
    }
    scheduleRefresh();
  });

  sse.onerror = () => {
    state.listening = false;
    $('rt-indicator').textContent = 'realtime: reconnecting';
    $('rt-indicator').className = 'pill pill-off';
  };
}

/**
 * The push frame carries the probe's id, not its nonce. Fetching the nonce
 * back over HTTP is the same "re-read authoritative state" rule the rest of
 * the console follows.
 */
async function fetchProbeNonce(probeId) {
  try {
    const events = await api('/events?limit=20');
    const match = events.events.find((e) => e.entity_id === probeId && e.type === 'realtime.probe');
    if (match?.payload?.nonce) {
      const already = state.probes.received.find((r) => r.nonce === match.payload.nonce);
      if (!already) state.probes.received.push({ nonce: match.payload.nonce, latencyMs: null });
    }
  } catch {
    /* the report step tolerates a missing nonce */
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, 400);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderChecks(payload) {
  $('summary').innerHTML = `
    <span class="verdict PASS">PASS ${payload.summary.pass}</span>
    <span class="verdict CONDITIONAL">CONDITIONAL ${payload.summary.conditional}</span>
    <span class="verdict FAIL">FAIL ${payload.summary.fail}</span>
    <span class="muted">of ${payload.summary.total} checks, read from the database at ${new Date(
      payload.generatedAt,
    ).toLocaleTimeString()}</span>`;

  $('checks').innerHTML = payload.checks
    .map(
      (check) => `
      <details class="check" ${check.verdict === 'FAIL' ? 'open' : ''}>
        <summary>
          <span class="check-title">
            <span class="verdict ${check.verdict}">${check.verdict}</span>
            <strong>${esc(check.title)}</strong>
          </span>
          <span class="muted">${esc(check.summary)}</span>
        </summary>
        <div class="check-body">
          <table>
            <tr><th>Assertion</th><th>Expected</th><th>Stored</th><th></th></tr>
            ${check.assertions
              .map(
                (a) => `<tr>
                  <td>${esc(a.label)}</td>
                  <td>${show(a.expected)}</td>
                  <td>${show(a.actual)}</td>
                  <td class="${a.ok ? 'ok' : 'bad'}">${a.ok ? 'ok' : 'MISMATCH'}</td>
                </tr>`,
              )
              .join('')}
          </table>
          <details><summary class="muted">evidence</summary><pre>${esc(
            JSON.stringify(check.evidence, null, 2),
          )}</pre></details>
        </div>
      </details>`,
    )
    .join('');
}

function renderState(data) {
  $('state').innerHTML = `
    <table>
      <tr><th>Counter</th><th>Rows</th></tr>
      ${Object.entries(data.counts || {})
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
        .join('')}
    </table>
    <h3 style="margin-top:12px">Products</h3>
    <table>
      <tr><th>SKU</th><th>Price</th><th>Version</th><th>Soft</th><th>Hard</th><th>Overflow</th><th>Max</th></tr>
      ${data.products
        .map(
          (p) => `<tr><td>${esc(p.sku)}</td><td>${money(p.current_price_cents)}</td><td>${esc(
            p.price_version,
          )}</td><td>${esc(p.soft_threshold)}</td><td>${esc(p.hard_limit)}</td><td>${esc(
            p.overflow_allowance,
          )}</td><td>${esc(p.max_units)}</td></tr>`,
        )
        .join('')}
    </table>
    <h3 style="margin-top:12px">Orders (latest 100)</h3>
    <table>
      <tr><th>Code</th><th>Customer</th><th>Channel</th><th>Status</th><th>Date</th><th>Total</th><th>Outstanding</th><th>Scenario</th></tr>
      ${data.orders
        .map(
          (o) => `<tr><td>${esc(o.code)}</td><td>${esc(o.customer_name)}</td><td>${esc(
            o.channel,
          )}</td><td>${esc(o.status)}</td><td>${esc(o.scheduled_date ?? '-')}</td><td>${money(
            o.total_cents,
          )}</td><td>${money(o.outstanding_cents)}</td><td>${esc(o.scenario_tag ?? '')}</td></tr>`,
        )
        .join('')}
    </table>`;
}

function renderInbox(data) {
  const parts = [];

  for (const e of data.paymentExceptions) {
    const suggestions = (e.suggestions || [])
      .map(
        (s) =>
          `<button data-accept-suggestion="${s.id}">Apply ${money(s.amountCents)} to ${esc(
            s.orderCode,
          )} (confidence ${s.confidence})</button>`,
      )
      .join(' ');
    parts.push(`<div class="card">
      <h3>Payment exception: ${esc(e.kind)} ${money(e.amount_cents)}</h3>
      <div class="muted">payment ${money(e.payment_amount_cents)}${
        e.payment_order_id ? '' : ', arrived with no order attached'
      }</div>
      <div class="row">${suggestions}</div>
      <div class="row">
        <button data-resolve-exception="${e.id}" data-code="ISSUE_CREDIT">Issue credit</button>
        <button data-resolve-exception="${e.id}" data-code="REFUND">Refund</button>
        <button data-resolve-exception="${e.id}" data-code="WRITE_OFF">Write off</button>
      </div>
    </div>`);
  }

  for (const d of data.discrepancies) {
    parts.push(`<div class="card">
      <h3>Consignment discrepancy: ${esc(d.partner_name)}</h3>
      <div class="muted">delivered ${d.delivered_units}, expected back ${d.expected_units}, returned ${
        d.actual_units
      } (delta ${d.delta_units})</div>
      <div class="row">
        <button data-resolve-discrepancy="${d.id}" data-code="ASSUME_SOLD">Assume Sold</button>
        <button data-resolve-discrepancy="${d.id}" data-code="BAKERY_MISSED_RETURN">Bakery Missed Return</button>
        <button data-resolve-discrepancy="${d.id}" data-code="WRITE_OFF_LOST">Write Off/Lost</button>
        <button data-resolve-discrepancy="${d.id}" data-code="OTHER">Other...</button>
      </div>
    </div>`);
  }

  for (const r of data.recommendations.filter((r) => r.status === 'PENDING')) {
    parts.push(`<div class="card">
      <h3>Recommendation</h3>
      <div>${esc(r.message)}</div>
      <div class="row">
        <button data-decide="${r.id}" data-decision="ACCEPT">Accept</button>
        <button data-decide="${r.id}" data-decision="REJECT">Reject</button>
      </div>
    </div>`);
  }

  for (const i of data.productionImpacts) {
    parts.push(`<div class="card">
      <h3>Production shortfall on order ${esc(i.order_code)}</h3>
      <div class="muted">${i.shortfall_units} units short, awaiting a human decision. No order was cancelled.</div>
      <div class="row"><button data-split="${i.commitment_id}" data-run="${i.run_id}">Split into two deliveries</button></div>
    </div>`);
  }

  const decided = data.recommendations.filter((r) => r.status !== 'PENDING');
  if (decided.length) {
    parts.push(`<div class="card">
      <h3>Recommendation history</h3>
      <table>
        <tr><th>Message</th><th>Decision</th><th>By</th><th>Effect</th></tr>
        ${decided
          .map(
            (r) => `<tr><td>${esc(r.message)}</td><td>${esc(r.status)}</td><td>${esc(
              r.decided_by_name ?? '-',
            )}</td><td>${esc(
              (r.effects || [])
                .map((e) => `${e.before?.allocated_units ?? '-'} -> ${e.after?.allocated_units ?? '-'}`)
                .join(', '),
            )}</td></tr>`,
          )
          .join('')}
      </table>
    </div>`);
  }

  $('inbox').innerHTML = parts.join('') || '<p class="muted">Nothing is waiting on a person.</p>';
}

function renderStream(id, rows, format) {
  $(id).innerHTML = rows.map((r) => `<div>${format(r)}</div>`).join('');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function refreshAll() {
  if (!state.token || !state.bakeryId) return;
  try {
    const [checks, stateData, inbox, events, audit] = await Promise.all([
      api('/checks'),
      api('/state'),
      api('/inbox'),
      api('/events?limit=40'),
      api('/audit?limit=40'),
    ]);
    renderChecks(checks);
    renderState(stateData);
    renderInbox(inbox);
    renderStream(
      'events',
      events.events,
      (e) => `#${e.id} <strong>${esc(e.type)}</strong> ${esc(e.entity_type)} ${esc(e.actor ?? 'system')}`,
    );
    renderStream(
      'audit',
      audit.audit,
      (a) =>
        `#${a.id} <strong>${esc(a.action)}</strong> ${esc(a.outcome)} ${esc(a.entity_type)} ${esc(
          a.actor ?? 'system',
        )}`,
    );
  } catch (err) {
    log(`refresh failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
const SCENARIOS = [
  ['availability', '1. Availability'],
  ['production', '2. Production'],
  ['failure', '3. Failure'],
  ['payments', '4. Payments'],
  ['credit', '5. Credit'],
  ['shipping', '6. Shipping'],
  ['consignment', '7. Consignment'],
  ['history', '8. History'],
  ['tesla', '9. Tesla brain'],
];

async function runScenario(key) {
  log(`running scenario: ${key}`);
  try {
    await api(`/scenarios/${key}/run`, { method: 'POST', body: {} });
    log(`scenario ${key}: stored`);
  } catch (err) {
    log(`scenario ${key} failed: ${err.message}`);
  }
  await refreshAll();
}

async function runAll() {
  for (const [key] of SCENARIOS) await runScenario(key);
}

async function runProbes() {
  log('running platform probes (real HTTP calls back into the API)');
  try {
    const result = await api('/probes/run', { method: 'POST', body: {} });
    log(`probes: ${result.passed}/${result.ran} behaved as required`);
  } catch (err) {
    log(`probes failed: ${err.message}`);
  }
  await refreshAll();
}

/**
 * Realtime test.
 *
 * 1. raise a probe in THIS tenant (this socket should receive it)
 * 2. sign in as the other tenant's owner and raise a probe there
 *    (this socket must NOT receive it)
 * 3. report what actually arrived; the server stores receipts, and the check
 *    reads both the presence and the absence of them
 */
async function runRealtime() {
  if (!state.listening) {
    log('realtime: stream is not connected yet');
    return;
  }
  state.probes.received = [];
  log('realtime: raising a probe in this tenant');
  const same = await api('/realtime/probe', { method: 'POST', body: {} });

  let cross = null;
  const otherEmail = prompt(
    'Email of a user in the OTHER bakery (used to raise a cross-tenant probe):',
    'owner@secondbakery.test',
  );
  if (otherEmail) {
    const password = prompt('Password for that user:', 'test-password');
    try {
      const session = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otherEmail, password }),
      }).then((r) => r.json());
      const otherBakery = session.user.memberships[0].bakeryId;
      cross = await fetch('/api/realtime/probe', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Bakery-Id': otherBakery,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }).then((r) => r.json());
      log(`realtime: raised a probe in the other tenant (${esc(session.user.memberships[0].bakeryName)})`);
    } catch (err) {
      log(`realtime: could not raise the cross-tenant probe (${err.message})`);
    }
  }

  log('realtime: waiting 2s for delivery');
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const received = state.probes.received.filter((r) => r.nonce);
  const report = await api('/realtime/report', {
    method: 'POST',
    body: {
      sameTenantProbeId: same.probeId,
      crossTenantProbeId: cross?.probeId ?? null,
      received: received.map((r) => ({ nonce: r.nonce, latencyMs: r.latencyMs ?? null })),
    },
  });
  log(`realtime: reported ${report.receivedNonces.length} received probe(s)`);
  await refreshAll();
}

// Delegated handlers for the inbox buttons.
document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  try {
    if (target.dataset.acceptSuggestion) {
      await api(`/payments/suggestions/${target.dataset.acceptSuggestion}/accept`, {
        method: 'POST',
        body: { note: 'Accepted from the console' },
      });
      log('suggestion applied');
    } else if (target.dataset.resolveException) {
      const code = target.dataset.code;
      const note = code === 'OTHER' ? prompt('Note (required):') : `Resolved as ${code}`;
      await api(`/payments/exceptions/${target.dataset.resolveException}/resolve`, {
        method: 'POST',
        body: { resolutionCode: code, note },
      });
      log(`payment exception resolved as ${code}`);
    } else if (target.dataset.resolveDiscrepancy) {
      const code = target.dataset.code;
      const note = code === 'OTHER' ? prompt('Note (required for Other):') : null;
      if (code === 'OTHER' && !note) return;
      await api(`/consignment/discrepancies/${target.dataset.resolveDiscrepancy}/resolve`, {
        method: 'POST',
        body: { resolutionCode: code, note },
      });
      log(`consignment discrepancy resolved as ${code}`);
    } else if (target.dataset.decide) {
      await api(`/recommendations/${target.dataset.decide}/decide`, {
        method: 'POST',
        body: { decision: target.dataset.decision, note: 'Decided from the console' },
      });
      log(`recommendation ${target.dataset.decision.toLowerCase()}ed`);
    } else if (target.dataset.split) {
      const dates = prompt('Two delivery dates, comma separated:', '2026-10-08,2026-10-09');
      if (!dates) return;
      const [a, b] = dates.split(',').map((s) => s.trim());
      await api(`/commitments/${target.dataset.split}/split`, {
        method: 'POST',
        body: {
          runId: target.dataset.run,
          reason: 'Split from the console after a failed bake',
          segments: [
            { quantity: 3, plannedDate: a },
            { quantity: 3, plannedDate: b },
          ],
        },
      });
      log('commitment split into two deliveries');
    } else {
      return;
    }
    await refreshAll();
  } catch (err) {
    log(`action failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('scenario-buttons').innerHTML = SCENARIOS.map(
  ([key, label]) => `<button data-scenario="${key}">${label}</button>`,
).join('');
$('scenario-buttons').addEventListener('click', (event) => {
  const key = event.target.dataset?.scenario;
  if (key) runScenario(key);
});

$('login').addEventListener('click', login);
$('password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});
$('logout').addEventListener('click', logout);
$('run-all').addEventListener('click', runAll);
$('run-probes').addEventListener('click', runProbes);
$('run-realtime').addEventListener('click', runRealtime);
$('refresh').addEventListener('click', refreshAll);
$('bakery-select').addEventListener('change', (e) => {
  state.bakeryId = e.target.value;
  openStream();
  refreshAll();
});

// Restore a session if one is still valid.
(async () => {
  const token = localStorage.getItem('mybake.token');
  if (!token) return;
  state.token = token;
  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.bakeryId = me.user.memberships[0]?.bakeryId ?? null;
    afterLogin();
  } catch {
    localStorage.removeItem('mybake.token');
    state.token = null;
  }
})();
