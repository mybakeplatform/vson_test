-- 001_init.sql
-- MyBake Platform Test - core schema.
--
-- Conventions:
--   * every tenant-scoped table carries bakery_id and is indexed on it
--   * money is integer cents, never float
--   * history tables are append-only and guarded by triggers
--   * domain events are written to `events`; a trigger turns each row into a
--     pg_notify payload so the API can push "something changed" to clients

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Guards for append-only / immutable history
-- ---------------------------------------------------------------------------

-- Admin escape hatch used only by the documented reset routine, which sets
-- mybake.allow_history_mutation = 'on' for the duration of one transaction.
CREATE OR REPLACE FUNCTION mybake_history_mutation_allowed() RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN coalesce(current_setting('mybake.allow_history_mutation', true), 'off') = 'on';
END $$;

CREATE OR REPLACE FUNCTION mybake_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE OR REPLACE FUNCTION mybake_forbid_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'table % is append-only: TRUNCATE is not permitted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------

CREATE TABLE bakeries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Membership is the ONLY source of authorization. A client-supplied bakery id
-- is never trusted; it is always checked against this table for the
-- session's user.
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bakery_id   uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('OWNER', 'STAFF', 'READONLY')),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bakery_id)
);
CREATE INDEX memberships_bakery_idx ON memberships (bakery_id);

CREATE TABLE sessions (
  token       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- Catalogue, versioned pricing, versioned recipes
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id   uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  sku         text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bakery_id, sku)
);

-- Price history. A row is never edited except to stamp superseded_at.
CREATE TABLE product_prices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id         uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version           integer NOT NULL,
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, version)
);
CREATE UNIQUE INDEX product_prices_one_current_idx
  ON product_prices (product_id) WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION mybake_price_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN RETURN NEW; END IF;
  IF NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    RAISE EXCEPTION 'product_prices rows are immutable; supersede and insert a new version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER product_prices_immutable
  BEFORE UPDATE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION mybake_price_immutable();
CREATE TRIGGER product_prices_no_delete
  BEFORE DELETE ON product_prices
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();

CREATE TABLE recipes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id   uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bakery_id, product_id, name)
);

CREATE TABLE recipe_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  recipe_id     uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  ingredients   jsonb NOT NULL,
  notes         text,
  effective_from timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version)
);
CREATE UNIQUE INDEX recipe_versions_one_current_idx
  ON recipe_versions (recipe_id) WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION mybake_recipe_version_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN RETURN NEW; END IF;
  IF NEW.ingredients IS DISTINCT FROM OLD.ingredients
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.recipe_id IS DISTINCT FROM OLD.recipe_id THEN
    RAISE EXCEPTION 'recipe_versions rows are immutable; publish a new version instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER recipe_versions_immutable
  BEFORE UPDATE ON recipe_versions
  FOR EACH ROW EXECUTE FUNCTION mybake_recipe_version_immutable();
CREATE TRIGGER recipe_versions_no_delete
  BEFORE DELETE ON recipe_versions
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Customers and orders
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id   uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('RETAIL', 'WHOLESALE', 'CONSIGNMENT_PARTNER')),
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bakery_id, name)
);

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id          uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  code               text NOT NULL,
  channel            text NOT NULL CHECK (channel IN ('PICKUP', 'DOOR_TO_DOOR', 'WHOLESALE', 'CONSIGNMENT')),
  status             text NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'AWAITING_SCHEDULING', 'SCHEDULED', 'FULFILLED', 'CANCELLED')),
  scheduled_date     date,
  requested_date     date,
  total_cents        integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents         integer NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  credit_cents       integer NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  scenario_tag       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bakery_id, code)
);
CREATE INDEX orders_bakery_idx ON orders (bakery_id);
CREATE INDEX orders_customer_idx ON orders (customer_id);

CREATE TABLE order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id         uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity          integer NOT NULL CHECK (quantity > 0),
  -- price is SNAPSHOT at order time, plus a pointer to the exact price version
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  price_version_id  uuid NOT NULL REFERENCES product_prices(id) ON DELETE RESTRICT,
  line_total_cents  integer NOT NULL CHECK (line_total_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

-- The captured price of an existing line can never drift with the catalogue.
CREATE OR REPLACE FUNCTION mybake_order_line_price_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN RETURN NEW; END IF;
  IF NEW.unit_price_cents IS DISTINCT FROM OLD.unit_price_cents
     OR NEW.price_version_id IS DISTINCT FROM OLD.price_version_id THEN
    RAISE EXCEPTION 'order_lines price snapshot is frozen for order line %', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER order_lines_price_frozen
  BEFORE UPDATE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION mybake_order_line_price_frozen();

-- ---------------------------------------------------------------------------
-- Availability engine
-- ---------------------------------------------------------------------------

CREATE TABLE availability_policies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id           uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  soft_threshold      integer NOT NULL CHECK (soft_threshold >= 0),
  hard_limit          integer NOT NULL CHECK (hard_limit >= 0),
  overflow_allowance  integer NOT NULL CHECK (overflow_allowance >= 0),
  max_units           integer GENERATED ALWAYS AS (hard_limit + overflow_allowance) STORED,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id),
  CHECK (soft_threshold <= hard_limit)
);

-- One row per (product, service_date). committed_units is the authoritative
-- counter and is only ever changed inside a row-locked transaction.
CREATE TABLE availability_days (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id        uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_date     date NOT NULL,
  committed_units  integer NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, service_date)
);

-- Every accept AND every reject is persisted. This is the evidence trail for
-- the availability test.
CREATE TABLE availability_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id         uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_date      date NOT NULL,
  requested_units   integer NOT NULL,
  committed_before  integer NOT NULL,
  committed_after   integer NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN ('ACCEPT', 'REJECT', 'RELEASE')),
  band              text NOT NULL CHECK (band IN ('NORMAL', 'SOFT', 'OVERFLOW', 'OVER_MAX', 'RELEASE')),
  reason            text NOT NULL,
  soft_threshold    integer NOT NULL,
  hard_limit        integer NOT NULL,
  overflow_allowance integer NOT NULL,
  max_units         integer NOT NULL,
  actor_user_id     uuid REFERENCES users(id),
  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX availability_decisions_lookup_idx
  ON availability_decisions (bakery_id, product_id, service_date, created_at);
CREATE TRIGGER availability_decisions_append_only
  BEFORE UPDATE OR DELETE ON availability_decisions
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();

-- A commitment is the unit of demand that consumes availability.
CREATE TABLE commitments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id  uuid NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  service_date   date NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  status         text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'RELEASED', 'AT_RISK')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  released_at    timestamptz
);
CREATE INDEX commitments_day_idx ON commitments (product_id, service_date, status);
CREATE INDEX commitments_order_idx ON commitments (order_id);

-- ---------------------------------------------------------------------------
-- Production
-- ---------------------------------------------------------------------------

-- Demand rows are what production works against. Rescheduling supersedes a
-- demand row rather than editing it.
CREATE TABLE production_demands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id     uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_date   date NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  source         text NOT NULL CHECK (source IN ('CUSTOMER', 'WHOLESALE', 'CONSIGNMENT', 'INTERNAL')),
  order_id       uuid REFERENCES orders(id) ON DELETE CASCADE,
  commitment_id  uuid REFERENCES commitments(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'OPEN'
                 CHECK (status IN ('OPEN', 'SUPERSEDED', 'FULFILLED', 'CANCELLED')),
  superseded_by  uuid REFERENCES production_demands(id),
  superseded_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_demands_day_idx ON production_demands (bakery_id, product_id, service_date, status);

CREATE TABLE production_plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id          uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_date       date NOT NULL,
  required_units     integer NOT NULL CHECK (required_units >= 0),
  planned_units      integer NOT NULL CHECK (planned_units >= 0),
  max_mixer_load     integer NOT NULL CHECK (max_mixer_load > 0),
  recipe_version_id  uuid NOT NULL REFERENCES recipe_versions(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'PLANNED'
                     CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED')),
  scenario_tag       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_plans_day_idx ON production_plans (bakery_id, product_id, service_date);

CREATE TABLE mixer_loads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  plan_id        uuid NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
  sequence       integer NOT NULL CHECK (sequence > 0),
  planned_units  integer NOT NULL CHECK (planned_units > 0),
  actual_units   integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, sequence)
);

CREATE TABLE production_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id          uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  service_date       date NOT NULL,
  -- the recipe version actually used, copied from the plan at run time
  recipe_version_id  uuid NOT NULL REFERENCES recipe_versions(id) ON DELETE RESTRICT,
  actual_units       integer NOT NULL DEFAULT 0 CHECK (actual_units >= 0),
  allocated_units    integer NOT NULL DEFAULT 0 CHECK (allocated_units >= 0),
  surplus_units      integer NOT NULL DEFAULT 0 CHECK (surplus_units >= 0),
  status             text NOT NULL
                     CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'PARTIAL')),
  failure_reason     text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX production_runs_plan_idx ON production_runs (plan_id);

-- The run's recipe version can never be swapped after the fact.
CREATE OR REPLACE FUNCTION mybake_run_recipe_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF mybake_history_mutation_allowed() THEN RETURN NEW; END IF;
  IF NEW.recipe_version_id IS DISTINCT FROM OLD.recipe_version_id THEN
    RAISE EXCEPTION 'production_runs.recipe_version_id is frozen for run %', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER production_runs_recipe_frozen
  BEFORE UPDATE ON production_runs
  FOR EACH ROW EXECUTE FUNCTION mybake_run_recipe_frozen();

CREATE TABLE production_allocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  commitment_id  uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  quantity       integer NOT NULL CHECK (quantity > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_allocations_run_idx ON production_allocations (run_id);

CREATE TABLE surplus_inventory (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  service_date  date NOT NULL,
  quantity      integer NOT NULL CHECK (quantity > 0),
  disposition   text NOT NULL DEFAULT 'AVAILABLE'
                CHECK (disposition IN ('AVAILABLE', 'SOLD', 'DONATED', 'DISCARDED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Operational split of a single commitment (e.g. 6 loaves -> 3 today + 3 later).
-- Never a second customer order.
CREATE TABLE fulfillment_segments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  commitment_id  uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence       integer NOT NULL CHECK (sequence > 0),
  quantity       integer NOT NULL CHECK (quantity > 0),
  planned_date   date NOT NULL,
  status         text NOT NULL DEFAULT 'PLANNED'
                 CHECK (status IN ('PLANNED', 'FULFILLED', 'CANCELLED')),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (commitment_id, sequence)
);

-- Commitments touched by a failed run, recorded without cancelling anything.
CREATE TABLE production_failure_impacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
  commitment_id  uuid NOT NULL REFERENCES commitments(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shortfall_units integer NOT NULL CHECK (shortfall_units >= 0),
  resolution     text NOT NULL DEFAULT 'AWAITING_HUMAN'
                 CHECK (resolution IN ('AWAITING_HUMAN', 'SPLIT_FULFILLMENT', 'CUSTOMER_CANCELLED', 'REBAKED')),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, commitment_id)
);

-- ---------------------------------------------------------------------------
-- Payments, credit
-- ---------------------------------------------------------------------------

-- A payment can exist with no order at all.
CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  method        text NOT NULL CHECK (method IN ('CASH', 'CARD', 'BANK_TRANSFER', 'OTHER')),
  external_ref  text,
  reference_note text,
  status        text NOT NULL DEFAULT 'UNAPPLIED'
                CHECK (status IN ('UNAPPLIED', 'PARTIALLY_APPLIED', 'APPLIED', 'NEEDS_REVIEW')),
  received_at   timestamptz NOT NULL DEFAULT now(),
  scenario_tag  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_bakery_idx ON payments (bakery_id);
-- Duplicate protection: the same bank reference cannot land twice in a tenant.
CREATE UNIQUE INDEX payments_external_ref_idx
  ON payments (bakery_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE payment_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  kind          text NOT NULL CHECK (kind IN ('AUTO_EXACT', 'HUMAN_APPLIED')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (payment_id);
CREATE INDEX payment_allocations_order_idx ON payment_allocations (order_id);

-- Anything the machine will not decide on its own.
CREATE TABLE payment_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('OVERPAYMENT', 'UNMATCHED', 'SHORTFALL', 'AMBIGUOUS')),
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_code text CHECK (resolution_code IN
                  ('APPLY_TO_ORDER', 'ISSUE_CREDIT', 'REFUND', 'WRITE_OFF', 'OTHER')),
  resolution_note text,
  resolved_by   uuid REFERENCES users(id),
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_exceptions_status_idx ON payment_exceptions (bakery_id, status);

-- Suggestions are advisory rows. They never create or modify an order.
CREATE TABLE payment_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  exception_id  uuid NOT NULL REFERENCES payment_exceptions(id) ON DELETE CASCADE,
  payment_id    uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id      uuid REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  confidence    numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  rationale     text NOT NULL,
  status        text NOT NULL DEFAULT 'SUGGESTED'
                CHECK (status IN ('SUGGESTED', 'ACCEPTED', 'DISMISSED')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  source        text NOT NULL CHECK (source IN ('GOODWILL', 'OVERPAYMENT', 'RETURN', 'MANUAL')),
  note          text,
  scenario_tag  text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  credit_id     uuid NOT NULL REFERENCES credits(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  sequence      integer NOT NULL CHECK (sequence > 0),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (credit_id, sequence)
);
CREATE INDEX credit_allocations_credit_idx ON credit_allocations (credit_id);
CREATE TRIGGER credit_allocations_append_only
  BEFORE UPDATE OR DELETE ON credit_allocations
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Bakery-controlled shipping queue
-- ---------------------------------------------------------------------------

CREATE TABLE shipping_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence       integer NOT NULL CHECK (sequence > 0),
  scheduled_date date NOT NULL,
  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'CANCELLED', 'DELIVERED')),
  assigned_by    uuid REFERENCES users(id),
  reason         text,
  superseded_by  uuid REFERENCES shipping_assignments(id),
  superseded_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, sequence)
);
CREATE UNIQUE INDEX shipping_assignments_one_active_idx
  ON shipping_assignments (order_id) WHERE status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- Consignment
-- ---------------------------------------------------------------------------

CREATE TABLE consignment_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id             uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  partner_id            uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  product_id            uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  delivered_units       integer NOT NULL CHECK (delivered_units > 0),
  expected_return_units integer NOT NULL CHECK (expected_return_units >= 0),
  delivered_on          date NOT NULL,
  status                text NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('OPEN', 'RETURN_RECORDED', 'DISCREPANCY', 'RECONCILED')),
  scenario_tag          text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consignment_returns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  delivery_id    uuid NOT NULL REFERENCES consignment_deliveries(id) ON DELETE CASCADE,
  returned_units integer NOT NULL CHECK (returned_units >= 0),
  returned_on    date NOT NULL,
  recorded_by    uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consignment_discrepancies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id       uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  delivery_id     uuid NOT NULL REFERENCES consignment_deliveries(id) ON DELETE CASCADE,
  return_id       uuid REFERENCES consignment_returns(id) ON DELETE SET NULL,
  expected_units  integer NOT NULL,
  actual_units    integer NOT NULL,
  delta_units     integer NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution_code text CHECK (resolution_code IN
                  ('ASSUME_SOLD', 'BAKERY_MISSED_RETURN', 'WRITE_OFF_LOST', 'OTHER')),
  resolution_note text,
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, return_id)
);

-- "OTHER" must carry a human explanation; nothing auto-resolves.
ALTER TABLE consignment_discrepancies ADD CONSTRAINT consignment_other_requires_note
  CHECK (resolution_code IS DISTINCT FROM 'OTHER' OR (resolution_note IS NOT NULL AND length(btrim(resolution_note)) > 0));
ALTER TABLE consignment_discrepancies ADD CONSTRAINT consignment_resolved_requires_human
  CHECK (status = 'OPEN' OR (resolution_code IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Recommendation engine ("Tesla brain")
-- ---------------------------------------------------------------------------

CREATE TABLE wholesale_allocations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id              uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  product_id             uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  service_date           date NOT NULL,
  allocated_units        integer NOT NULL CHECK (allocated_units >= 0),
  version                integer NOT NULL CHECK (version > 0),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
  source_recommendation_id uuid,
  scenario_tag           text,
  superseded_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, service_date, version)
);
CREATE UNIQUE INDEX wholesale_allocations_one_active_idx
  ON wholesale_allocations (product_id, service_date) WHERE status = 'ACTIVE';

CREATE TABLE recommendations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  product_id     uuid REFERENCES products(id) ON DELETE SET NULL,
  service_date   date,
  message        text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  scenario_tag   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recommendations_bakery_idx ON recommendations (bakery_id, status, created_at);

-- What a decision actually changed, before/after. Never deleted.
CREATE TABLE recommendation_effects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id          uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  recommendation_id  uuid NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  entity_type        text NOT NULL,
  entity_id          uuid,
  before_state       jsonb,
  after_state        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER recommendation_effects_append_only
  BEFORE UPDATE OR DELETE ON recommendation_effects
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Events, audit, idempotency, probes
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id             bigserial PRIMARY KEY,
  bakery_id      uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  type           text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id  uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_bakery_idx ON events (bakery_id, id DESC);
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION mybake_forbid_truncate();

CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  bakery_id      uuid REFERENCES bakeries(id) ON DELETE CASCADE,
  actor_user_id  uuid REFERENCES users(id),
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid,
  outcome        text NOT NULL DEFAULT 'ALLOWED' CHECK (outcome IN ('ALLOWED', 'DENIED')),
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  ip             text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_bakery_idx ON audit_log (bakery_id, id DESC);
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION mybake_forbid_truncate();

-- Every event row becomes one NOTIFY. Clients are told *that* something
-- changed and then re-read authoritative state over HTTP.
CREATE OR REPLACE FUNCTION mybake_notify_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('mybake_events', json_build_object(
    'event_id',    NEW.id,
    'bakery_id',   NEW.bakery_id,
    'type',        NEW.type,
    'entity_type', NEW.entity_type,
    'entity_id',   NEW.entity_id,
    'created_at',  NEW.created_at
  )::text);
  RETURN NEW;
END $$;

CREATE TRIGGER events_notify
  AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION mybake_notify_event();

-- Duplicate protection for unsafe-to-repeat POSTs.
CREATE TABLE idempotency_keys (
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  key           text NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  status_code   integer,
  response_body jsonb,
  state         text NOT NULL DEFAULT 'IN_FLIGHT' CHECK (state IN ('IN_FLIGHT', 'COMPLETED')),
  replay_count  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  PRIMARY KEY (bakery_id, key)
);

-- Realtime evidence: a probe is an event deliberately raised in one tenant;
-- receipts record which subscriber actually received the notification.
CREATE TABLE realtime_probes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  nonce         text NOT NULL UNIQUE,
  raised_by     uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE realtime_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_id              uuid NOT NULL REFERENCES realtime_probes(id) ON DELETE CASCADE,
  subscriber_bakery_id  uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  subscriber_user_id    uuid REFERENCES users(id),
  channel               text NOT NULL DEFAULT 'sse',
  latency_ms            integer,
  received_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (probe_id, subscriber_bakery_id, subscriber_user_id)
);

-- Probe evidence: each deliberately hostile or duplicated request and what
-- the server actually did with it.
CREATE TABLE platform_probes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category           text NOT NULL CHECK (category IN
                     ('TENANT_ISOLATION', 'SERVER_AUTHORIZATION', 'DUPLICATE_PROTECTION')),
  actor_user_id      uuid REFERENCES users(id),
  actor_bakery_id    uuid REFERENCES bakeries(id) ON DELETE SET NULL,
  target_bakery_id   uuid REFERENCES bakeries(id) ON DELETE SET NULL,
  attempt            text NOT NULL,
  expected_outcome   text NOT NULL,
  observed_status    integer NOT NULL,
  observed_outcome   text NOT NULL,
  passed             boolean NOT NULL,
  detail             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_probes_category_idx ON platform_probes (category, created_at DESC);

-- Record of every scenario run, so the console can show what evidence exists.
CREATE TABLE scenario_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id     uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  scenario      text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scenario_runs_lookup_idx ON scenario_runs (bakery_id, scenario, created_at DESC);
