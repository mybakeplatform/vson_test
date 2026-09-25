# Architecture

One Node process, one Postgres database, one static console. The interesting
decisions are about where rules are enforced and what gets kept.

## Layers

```
public/          diagnostic console (plain JS, no build step)
  |  HTTP + SSE
src/routes/      endpoints: authenticate -> resolve tenant -> idempotency -> handler
src/domain/      business rules; every function takes a transaction client
db/migrations/   schema, constraints and triggers - the last line of defence
```

A route never contains a business rule, and a domain function never trusts an
id it was handed without re-reading the row inside the tenant.

## Tenancy

`memberships(user_id, bakery_id, role)` is the only source of authorization.

On every request, `requireTenant` reads the session's memberships **from the
database** and compares them against the bakery id the client asked for. The
client-supplied id is a selector, never a credential. A miss is a 403 and is
written to `audit_log` with `outcome = 'DENIED'`, so refusals are evidence
rather than silence.

Two rules close the obvious hole:

- only an OWNER of the target bakery may grant membership
- nobody may grant membership to themselves, in any bakery

There is no endpoint anywhere that lets a session move itself between tenants.

Reads are tenant-scoped in SQL, not filtered afterwards, so another tenant's
row returns 404 rather than 403: the API does not confirm that the id exists.

## Money

Integer cents everywhere. An order's `total_cents` is denormalised for
display, but `outstanding` is always recomputed from `payment_allocations` and
`credit_allocations`, and the check engine cross-validates the two.

## History that cannot move

Three mechanisms, in increasing order of strength:

1. **Versioned rows.** `product_prices` and `recipe_versions` are append-only
   version chains; the current row is the one with `superseded_at IS NULL`,
   guarded by a partial unique index.
2. **Snapshots at the point of commitment.** `order_lines` store both
   `unit_price_cents` and `price_version_id`; `production_runs` store the
   `recipe_version_id` they actually used.
3. **Database triggers.** `order_lines.unit_price_cents`,
   `production_runs.recipe_version_id`, and the whole of `events`,
   `audit_log`, `availability_decisions`, `credit_allocations` and
   `recommendation_effects` refuse UPDATE and DELETE outright.

The check engine proves point 3 at runtime: inside a savepoint it attempts the
forbidden write against a specific existing row and records whether the
database refused, then rolls back. An UPDATE that matches no rows would
"succeed" without the guard firing, so the probes always target a real id.

Resetting a scenario needs to remove its slice, which touches some of those
guarded tables. That is done under a transaction-scoped
`mybake.allow_history_mutation` flag, and the reset itself is audited. Events,
audit rows and recommendations are never reset.

## Availability

`availability_days` holds one counter per product-day. Every decision:

1. `SELECT ... FOR UPDATE` the counter row (created on demand)
2. compute `committed + requested` against `hard_limit + overflow_allowance`
3. accept the whole request or reject the whole request
4. write an `availability_decisions` row either way

All-or-nothing falls out of the structure: the quantity is never partially
consumed, so 53 + 1 is a rejection, not an acceptance of zero. A multi-line
order groups its lines by product and releases anything already taken if a
later group is rejected, so an order never half-books a day.

Rejections are committed, not rolled back. A refusal you cannot see afterwards
is not a refusal you can audit.

## Production

`splitMixerLoads(planned, max)` uses the fewest loads that fit and balances
them: 65 in a 33 mixer is `[32, 33]`, never `[33, 32, ...]` or `[33, 33]`.

Allocation runs oldest commitment first. Output above demand becomes
`surplus_inventory`; demand is never rewritten upward to match a lucky bake.
Output below demand produces `production_failure_impacts` rows with
`resolution = 'AWAITING_HUMAN'` - never a cancellation.

A `fulfillment_segment` is an operational split of one commitment. The split
must sum to the original quantity (enforced), so an operational decision can
never quietly change what the customer ordered, and no second order is
created.

## Payments

The machine decides only what is unambiguous: money against a named order, up
to what that order is owed. Anything else becomes a `payment_exceptions` row
with `payment_suggestions` attached.

Suggestions point at orders that already exist and carry a confidence and a
rationale. There is no code path that creates an order to absorb a payment,
and the payments check compares the order count before and after to prove it.

`payments.order_id` is nullable: a payment is a first-class record that can
exist with no order at all.

## Shipping

Rescheduling never edits the old row. The October 1 assignment becomes
`SUPERSEDED` and points at its replacement via `superseded_by`; the October 1
`production_demands` row does the same. A partial unique index enforces
exactly one `ACTIVE` assignment per order. The capacity for the old day is
released and the new day is reserved in the same transaction.

## Recommendations

`evaluateSupply` writes a `recommendations` row with `status = 'PENDING'` and
`payload.autoApplied = false`, and stops. Applying happens only through
`decide`, which records a `recommendation_effects` row with before and after
state - including for a rejection, where before and after are identical. That
is what lets the check prove the reject path did nothing.

## Realtime

```
INSERT INTO events  ->  trigger pg_notify('mybake_events', {ids})
                    ->  server LISTEN, fan out to that tenant's SSE sockets
                    ->  client re-reads authoritative state over HTTP
```

The SSE frame carries an event id, type and entity id. It is not the data and
it is not the database. The console never renders from a push payload; it uses
it as a signal to re-read.

Fan-out filters by `bakery_id`, so a notice for one tenant is never written to
another tenant's socket. The realtime check proves both halves: a receipt
exists for the same-tenant probe, and no receipt exists for the probe raised
in the other tenant.

Because the transport is Postgres `NOTIFY`, horizontal scaling needs no extra
infrastructure: every instance listens, and every instance serves its own
subscribers.

## Duplicate protection

Two independent mechanisms:

- `Idempotency-Key` on unsafe requests. The first call runs and its response
  is stored; a replay returns the stored response with `X-Idempotent-Replay:
  true` and never re-executes. A replay with a different body is a 409, not a
  silent answer. Failed attempts release the key so a genuine retry works.
- Natural keys in the schema: `payments(bakery_id, external_ref)`,
  `orders(bakery_id, code)`, `memberships(user_id, bakery_id)` and others.

## The check engine

`src/checks/index.ts` is the only place that decides PASS, CONDITIONAL or
FAIL. Each check runs its own queries and builds a list of assertions with an
expected value and the value actually found in the database.

- every assertion satisfied -> **PASS**
- any assertion contradicted -> **FAIL**
- the evidence is not there yet -> **CONDITIONAL**

CONDITIONAL is never used to excuse a contradiction. It means the scenario has
not run, or a decision a human must make has not been made.
