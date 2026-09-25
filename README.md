# MyBake Platform Test

A platform acceptance harness, not the MyBake product. It exists to prove that a
platform can carry real bakery business rules: persistent relational data,
server-enforced limits, tenant isolation, historical integrity, realtime,
and an audit trail you can point at afterwards.

Every verdict the console shows is computed by reading rows back out of
Postgres. Nothing is asserted from explanatory text.

## What it demonstrates

| # | Test | Where the rule lives |
|---|------|----------------------|
| 1 | Availability engine: soft 45, hard 50, overflow 3, max 53 | `src/domain/availability.ts` |
| 2 | Production 65 required -> 32 + 33 mixer loads -> 68 actual -> 65 allocated, 3 surplus | `src/domain/production.ts` |
| 3 | Failed run: nobody cancelled, one order split 3 today + 3 later | `src/domain/production.ts` |
| 4 | Payment brain: exact match, unresolved overpayment, unmatched payment with suggestions | `src/domain/payments.ts` |
| 5 | Credit: $30 spent as $12 + $15 + $3, leaving $17 due | `src/domain/credit.ts` |
| 6 | Bakery-controlled shipping: no date -> Oct 1 -> Oct 2, Oct 1 kept as history | `src/domain/shipping.ts` |
| 7 | Consignment: 10 out, 2 expected, 0 back, discrepancy left for a person; the chosen resolution then settles the units to sold / owed back / written off | `src/domain/consignment.ts` |
| 8 | Historical integrity: old order stays $14, old run stays recipe v1 | `src/domain/catalog.ts` + schema triggers |
| 9 | Tesla brain: recommends, never applies; accept and reject both recorded | `src/domain/tesla.ts` |

Plus tenant isolation, server-side authorization, duplicate protection,
realtime, event history and audit history, each with its own check.

## Requirements

- Node.js 20 or newer (developed on 22)
- PostgreSQL 14 or newer (developed against 16 and 17; uses `pgcrypto`, generated columns,
  partial unique indexes, `LISTEN`/`NOTIFY`)

That is the entire infrastructure list. No queue, no cache, no object store,
no vendor SDK, no proprietary runtime.

## Run it locally

### With Docker (nothing else installed)

```bash
git clone https://github.com/mybakeplatform/vson_test.git
cd vson_test
docker compose up --build
# open http://localhost:3000
```

### Against your own Postgres

```bash
git clone https://github.com/mybakeplatform/vson_test.git
cd vson_test
npm install

cp .env.example .env
# edit DATABASE_URL to point at your database

npm run migrate   # create the schema
npm run seed      # create the two test tenants
npm run dev       # http://localhost:3000
```

`npm run dev` migrates and seeds on boot as well, so in practice
`npm install && npm run dev` with a valid `DATABASE_URL` is enough. Set
`MIGRATE_ON_BOOT=false` and `SEED_ON_BOOT=false` if you would rather run those
as explicit deploy steps.

### Sign in

| Email | Password | Role |
|-------|----------|------|
| `owner@crustandcrackle.test` | `test-password` | OWNER of Crust & Crackle Test Bakery |
| `baker@crustandcrackle.test` | `test-password` | STAFF of Crust & Crackle Test Bakery |
| `owner@secondbakery.test` | `test-password` | OWNER of Second Bakery Test |

The password comes from `SEED_PASSWORD`. These users exist only because the
seed creates them.

### Using the console

1. Sign in as the Crust & Crackle owner.
2. **Run all scenarios** drives all nine business scenarios.
3. **Run platform probes** makes real HTTP calls back into the API with forged
   tenant ids and duplicate requests, and stores what the server answered.
4. **Run realtime test** raises a probe in this tenant and one in the other,
   then reports which arrived on this socket.
5. The Tesla check stays CONDITIONAL until both decision paths exist: accept
   the pending recommendation, run the Tesla scenario again, then reject the
   new one.

Verdicts:

- **PASS** - every assertion is satisfied by stored rows
- **FAIL** - at least one assertion is contradicted by stored rows
- **CONDITIONAL** - the evidence needed to decide is not stored yet (the
  scenario has not run, or a required human decision is missing)

## Test it

```bash
npm test         # unit + full end-to-end acceptance suite
npm run typecheck
```

`tests/acceptance.test.ts` boots the real server on an ephemeral port against
`DATABASE_URL`, drives every scenario and every human decision over HTTP,
reads an SSE stream to verify realtime delivery and cross-tenant silence, and
then asserts that all fifteen checks return PASS. It needs a reachable
database; there are no mocks.

Use a throwaway database if you do not want the suite writing into a shared
one:

```bash
DATABASE_URL=postgresql://mybake:mybake@localhost:5432/mybake_test npm test
```

## Deploy it

The app is a single stateless Node process plus Postgres. Any of these work:

**Container**

```bash
docker build -t mybake-platform-test .
docker run -p 3000:3000 -e DATABASE_URL="postgresql://..." mybake-platform-test
```

**Platform-as-a-service (Render, Fly, Railway, App Runner, Heroku, ...)**

- Build: `npm ci && npm run build`
- Start: `npm start`
- Required env: `DATABASE_URL`
- Optional env: `PORT`, `SEED_PASSWORD`, `CORS_ORIGINS`, `MIGRATE_ON_BOOT`,
  `SEED_ON_BOOT`, `SELF_URL`, `PGSSLMODE`

**Behind a proxy** - the app sets `trust proxy` and disables buffering headers
for the SSE endpoint. If your proxy buffers responses, disable it for
`/api/realtime/stream`.

Run one instance or many: all state is in Postgres, and realtime is driven by
Postgres `NOTIFY`, so every instance sees every change. Sessions are database
rows, so there is no sticky-session requirement.

## Database: migrate, back up, restore

**Migrate**

```bash
npm run migrate          # apply everything pending
npm run migrate:status   # list applied and pending
```

Migrations are plain SQL in `db/migrations`, applied in filename order, one
transaction each, recorded in `schema_migrations` with a sha256 checksum.
Never edit an applied migration; add a new file. The runner warns loudly if a
checksum has drifted.

**Back up**

```bash
pg_dump --no-owner --no-privileges --format=custom "$DATABASE_URL" > mybake.dump
```

> **Your `pg_dump` must be at least as new as the server.** `pg_dump` refuses to
> dump a server newer than itself, and the error names both versions:
>
> ```
> pg_dump: error: aborting because of server version mismatch
> pg_dump: detail: server version: 17.10; pg_dump version: 15.19
> ```
>
> Check the pair before you rely on the command:
>
> ```bash
> pg_dump --version
> psql "$DATABASE_URL" -tAc 'SHOW server_version'
> ```
>
> If the client is older, install a matching one (`postgresql-client-<major>`
> from the PGDG repository) or dump from a container that already has it:
>
> ```bash
> docker run --rm postgres:17-alpine \
>   pg_dump --no-owner --no-privileges --format=custom "$DATABASE_URL" > mybake.dump
> ```
>
> The Vson development workspace currently ships `pg_dump` 15 against a
> PostgreSQL 17 server, so **the command above does not run from inside that
> workspace** - use one of the two options here. This is a client-tooling
> limitation, not a property of the database: the server is ordinary
> PostgreSQL and dumps normally from any machine with a current client.

**Restore**

```bash
createdb mybake_restored
pg_restore --no-owner --no-privileges --dbname="postgresql://.../mybake_restored" mybake.dump
```

The dump is a complete restore: there is no state anywhere else. Point
`DATABASE_URL` at the restored database and start the app.

**Wipe and start over** (development only - this deletes event and audit
history, which the application itself cannot do):

```bash
RESET_CONFIRM=yes npm run db:reset
```

## Project layout

```
db/migrations/     SQL schema, forward-only, checksummed
src/
  app.ts           Express wiring, CORS, error mapping
  main.ts          boot: migrate -> seed -> LISTEN -> serve
  auth.ts          sessions, membership lookup, tenant resolution
  db.ts            the single connection pool
  events.ts        domain events + audit writes
  idempotency.ts   duplicate protection for unsafe requests
  realtime.ts      Postgres LISTEN -> SSE fan-out
  domain/          the business rules, one file per area
  scenarios/       scenario runners that drive the real domain services
  checks/          the check engine: PASS / CONDITIONAL / FAIL from stored rows
  routes/          HTTP endpoints
  cli/             migrate, seed, reset
public/            the diagnostic console (no build step)
tests/             unit + end-to-end acceptance suite
```

Further reading: [ARCHITECTURE.md](ARCHITECTURE.md) for how the rules are
enforced.
