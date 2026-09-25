/**
 * Fixed coordinates for every scenario, so the check engine can find the
 * evidence a scenario leaves behind without guessing.
 *
 * Each scenario owns its own service date(s), which keeps the availability
 * counters of one test out of another test's way. Shipping deliberately uses
 * October 1 and October 2, as the acceptance test specifies.
 */
export const SCENARIO_KEYS = [
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

export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export const DATES = {
  availability: '2026-10-06',
  production: '2026-10-07',
  failureDay1: '2026-10-08',
  failureDay2: '2026-10-09',
  payments: '2026-10-10',
  credit: '2026-10-11',
  shippingFirst: '2026-10-01',
  shippingSecond: '2026-10-02',
  consignment: '2026-10-12',
  history: '2026-10-13',
  tesla: '2026-10-14',
} as const;

export const SKU = {
  countryBlonde: 'COUNTRY-BLONDE',
  hearthMiche: 'HEARTH-MICHE',
  sourdoughRoll: 'SOURDOUGH-ROLL',
  heritageLoaf: 'HERITAGE-LOAF',
} as const;

/** The availability policy the acceptance test pins down. */
export const COUNTRY_BLONDE_POLICY = {
  softThreshold: 45,
  hardLimit: 50,
  overflowAllowance: 3,
  maxUnits: 53,
} as const;

export const MAX_MIXER_LOAD = 33;

export const SCENARIO_TITLES: Record<ScenarioKey, string> = {
  availability: '1. Availability engine (45 / 50 / +3 / 53)',
  production: '2. Production 65 -> 32+33 -> 68 -> 3 surplus',
  failure: '3. Production failure and partial fulfillment',
  payments: '4. Payment brain',
  credit: '5. Credit allocation ($30 across three orders)',
  shipping: '6. Bakery-controlled shipping queue (Oct 1 -> Oct 2)',
  consignment: '7. Consignment discrepancy',
  history: '8. Historical integrity (price and recipe)',
  tesla: '9. Tesla brain (recommend, never auto-apply)',
};
