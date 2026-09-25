-- 002_consignment_settlement.sql
-- The operational consequence of a human's consignment decision.
--
-- consignment_discrepancies records what was OBSERVED (expected vs actual back)
-- and who decided. Those numbers never change. This table records what the
-- decision MEANT for stock and money, as a separate append-only row, so the
-- observation and its consequence can never overwrite one another.
--
-- The four resolution codes stay semantically distinct here - this is the only
-- place where the difference between "assume sold" and "write off" becomes a
-- number rather than a label:
--
--   ASSUME_SOLD           units_sold        - partner sold them, revenue is due
--   BAKERY_MISSED_RETURN  units_owed_back   - still the bakery's stock, uncollected
--   WRITE_OFF_LOST        units_written_off - gone, no revenue
--   OTHER                 units_unaccounted - the human's note carries the meaning

CREATE TABLE consignment_settlements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bakery_id         uuid NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  delivery_id       uuid NOT NULL REFERENCES consignment_deliveries(id) ON DELETE CASCADE,
  discrepancy_id    uuid NOT NULL REFERENCES consignment_discrepancies(id) ON DELETE CASCADE,
  product_id        uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  resolution_code   text NOT NULL
                    CHECK (resolution_code IN ('ASSUME_SOLD', 'BAKERY_MISSED_RETURN',
                                               'WRITE_OFF_LOST', 'OTHER')),

  -- How the unreturned units were accounted for. Exactly one bucket is used
  -- per resolution, and the buckets must add up to what went missing.
  units_unreturned   integer NOT NULL CHECK (units_unreturned > 0),
  units_sold         integer NOT NULL DEFAULT 0 CHECK (units_sold >= 0),
  units_owed_back    integer NOT NULL DEFAULT 0 CHECK (units_owed_back >= 0),
  units_written_off  integer NOT NULL DEFAULT 0 CHECK (units_written_off >= 0),
  units_unaccounted  integer NOT NULL DEFAULT 0 CHECK (units_unaccounted >= 0),

  -- Revenue recognised, priced with a SNAPSHOT of the version in force when the
  -- human decided - the same rule order_lines follows, for the same reason.
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  price_version_id  uuid REFERENCES product_prices(id) ON DELETE RESTRICT,
  revenue_cents     integer NOT NULL CHECK (revenue_cents >= 0),

  -- Consignment stock the bakery still counts as its own, before and after.
  bakery_held_units_before integer NOT NULL CHECK (bakery_held_units_before >= 0),
  bakery_held_units_after  integer NOT NULL CHECK (bakery_held_units_after >= 0),

  decided_by        uuid NOT NULL REFERENCES users(id),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- One settlement per decision: a discrepancy cannot be settled twice.
  UNIQUE (discrepancy_id),
  CONSTRAINT consignment_settlement_units_balance
    CHECK (units_sold + units_owed_back + units_written_off + units_unaccounted
           = units_unreturned)
);

CREATE INDEX consignment_settlements_delivery_idx
  ON consignment_settlements (bakery_id, delivery_id);

-- A settlement is history: it is written once and never edited.
CREATE TRIGGER consignment_settlements_append_only
  BEFORE UPDATE OR DELETE ON consignment_settlements
  FOR EACH ROW EXECUTE FUNCTION mybake_forbid_mutation();
