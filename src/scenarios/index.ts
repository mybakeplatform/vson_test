/**
 * Scenario runners.
 *
 * Each one drives the REAL domain services over the REAL schema - there are
 * no shortcut inserts here. What the checks later read is whatever the
 * business rules actually wrote.
 */
import type { PoolClient } from 'pg';
import { one } from '../db.js';
import { writeAudit } from '../events.js';
import * as availability from '../domain/availability.js';
import * as catalog from '../domain/catalog.js';
import * as consignment from '../domain/consignment.js';
import * as credit from '../domain/credit.js';
import * as orders from '../domain/orders.js';
import * as payments from '../domain/payments.js';
import * as production from '../domain/production.js';
import * as shipping from '../domain/shipping.js';
import * as tesla from '../domain/tesla.js';
import { DATES, MAX_MIXER_LOAD, SKU, type ScenarioKey } from './constants.js';
import { customerIdByName, productIdBySku, recipeIdForProduct } from './refs.js';
import { resetScenario } from './reset.js';

export interface ScenarioContext {
  bakeryId: string;
  actorUserId: string;
}

type Runner = (client: PoolClient, ctx: ScenarioContext) => Promise<Record<string, unknown>>;

// --------------------------------------------------------------------------
// 1. Availability engine
// --------------------------------------------------------------------------
const runAvailability: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.countryBlonde);
  const date = DATES.availability;
  const customer = await customerIdByName(client, ctx.bakeryId, 'Ada Rye');

  const place = async (quantity: number, code: string) =>
    orders.createOrder(client, {
      bakeryId: ctx.bakeryId,
      actorUserId: ctx.actorUserId,
      customerId: customer,
      channel: 'PICKUP',
      serviceDate: date,
      lines: [{ productId, quantity }],
      code,
      scenarioTag: 'availability',
    });

  const steps: Record<string, unknown>[] = [];
  const note = (label: string, result: orders.CreateOrderResult) => {
    const decision = result.rejection ?? result.decisions.at(-1)!;
    steps.push({
      label,
      outcome: decision.outcome,
      requested: decision.requestedUnits,
      committedBefore: decision.committedBefore,
      committedAfter: decision.committedAfter,
      band: decision.band,
      orderId: result.order?.id ?? null,
    });
    return result;
  };

  // Fill the day to exactly the hard limit.
  note('seed to 50', await place(50, 'AV-BASE-50'));

  const one51 = note('50 + 1', await place(1, 'AV-51'));
  const one52 = note('51 + 1', await place(1, 'AV-52'));
  const one53 = note('52 + 1', await place(1, 'AV-53'));
  note('53 + 1 (must reject)', await place(1, 'AV-54-REJECT'));

  // Back to 50 by cancelling the three single-unit orders.
  for (const result of [one51, one52, one53]) {
    if (result.order) {
      await orders.cancelOrder(client, {
        bakeryId: ctx.bakeryId,
        actorUserId: ctx.actorUserId,
        orderId: result.order.id as string,
        reason: 'Availability test: reset to 50',
      });
    }
  }
  steps.push({ label: 'reset to 50', outcome: 'RELEASE', committedAfter: 50 });

  note('50 + 3 in one request', await place(3, 'AV-53-BULK'));

  const final = await availability.snapshot(client, ctx.bakeryId, productId, date);
  return { productId, serviceDate: date, steps, finalCommitted: final.committed, policy: final.policy };
};

// --------------------------------------------------------------------------
// 2. Production: 65 required -> 32 + 33 -> 68 actual -> 65 allocated, 3 surplus
// --------------------------------------------------------------------------
const runProduction: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.hearthMiche);
  const date = DATES.production;
  const names = ['Ada Rye', 'Ben Oat', 'Cleo Spelt', 'Dov Kamut', 'Esme Durum'];
  const quantities = [20, 15, 12, 10, 8]; // 65

  for (const [i, quantity] of quantities.entries()) {
    const customerId = await customerIdByName(client, ctx.bakeryId, names[i]!);
    const result = await orders.createOrder(client, {
      bakeryId: ctx.bakeryId,
      actorUserId: ctx.actorUserId,
      customerId,
      channel: 'PICKUP',
      serviceDate: date,
      lines: [{ productId, quantity }],
      code: `PROD-${i + 1}`,
      scenarioTag: 'production',
    });
    if (!result.accepted) throw new Error(`Production scenario setup rejected: ${result.rejection?.reason}`);
  }

  const plan = await production.createPlan(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: date,
    maxMixerLoad: MAX_MIXER_LOAD,
    scenarioTag: 'production',
  });

  const run = await production.completeRun(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    planId: plan.plan.id,
    actualUnits: 68,
  });

  return {
    productId,
    serviceDate: date,
    planId: plan.plan.id,
    mixerLoads: plan.mixerLoads,
    ...run,
  };
};

// --------------------------------------------------------------------------
// 3. Failed run: nobody is cancelled, one order is split 3 + 3
// --------------------------------------------------------------------------
const runFailure: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.hearthMiche);
  const customerId = await customerIdByName(client, ctx.bakeryId, 'Ada Rye');

  const order = await orders.createOrder(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    customerId,
    channel: 'PICKUP',
    serviceDate: DATES.failureDay1,
    lines: [{ productId, quantity: 6 }],
    code: 'FAIL-6',
    scenarioTag: 'failure',
  });
  if (!order.accepted) throw new Error('Failure scenario setup rejected');

  const plan = await production.createPlan(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: DATES.failureDay1,
    maxMixerLoad: MAX_MIXER_LOAD,
    scenarioTag: 'failure',
  });

  const failed = await production.failRun(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    planId: plan.plan.id,
    reason: 'Levain collapsed; whole batch unusable',
  });

  const commitmentId = failed.affected[0]?.id;
  if (!commitmentId) throw new Error('Failure scenario found no affected commitment');

  // A person decides to deliver in two parts. Same order, same customer.
  const split = await production.splitCommitment(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    commitmentId,
    runId: failed.runId,
    reason: 'Bake failed: 3 delivered on the original day, 3 the following day',
    segments: [
      { quantity: 3, plannedDate: DATES.failureDay1 },
      { quantity: 3, plannedDate: DATES.failureDay2 },
    ],
  });

  return {
    orderId: order.order!.id,
    planId: plan.plan.id,
    runId: failed.runId,
    commitmentId,
    affectedCommitments: failed.affected.length,
    segments: split.segments,
  };
};

// --------------------------------------------------------------------------
// 4. Payment brain
// --------------------------------------------------------------------------
const runPayments: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.countryBlonde);
  const date = DATES.payments;

  const makeOrder = async (customerName: string, quantity: number, code: string) => {
    const customerId = await customerIdByName(client, ctx.bakeryId, customerName);
    const result = await orders.createOrder(client, {
      bakeryId: ctx.bakeryId,
      actorUserId: ctx.actorUserId,
      customerId,
      channel: 'PICKUP',
      serviceDate: date,
      lines: [{ productId, quantity }],
      code,
      scenarioTag: 'payments',
    });
    if (!result.accepted) throw new Error(`Payments scenario setup rejected: ${result.rejection?.reason}`);
    return { orderId: result.order!.id as string, customerId };
  };

  // $42 order paid with exactly $42.
  const exact = await makeOrder('Ada Rye', 3, 'PAY-EXACT-42');
  const exactPayment = await payments.recordPayment(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    orderId: exact.orderId,
    customerId: exact.customerId,
    amountCents: 4200,
    method: 'CARD',
    scenarioTag: 'payments',
    note: 'Exact settlement',
  });

  // $42 order paid with $48: six dollars the machine will not place.
  const over = await makeOrder('Ben Oat', 3, 'PAY-OVER-48');
  const overPayment = await payments.recordPayment(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    orderId: over.orderId,
    customerId: over.customerId,
    amountCents: 4800,
    method: 'BANK_TRANSFER',
    scenarioTag: 'payments',
    note: 'Customer rounded up',
  });

  // An unpaid $14 order gives the next payment something to be suggested against.
  const candidate = await makeOrder('Dov Kamut', 1, 'PAY-CANDIDATE-14');

  // $14 arrives with no order and no customer attached.
  const ordersBefore = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM orders WHERE bakery_id = $1',
    [ctx.bakeryId],
    client,
  );
  const unmatched = await payments.recordPayment(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    amountCents: 1400,
    method: 'BANK_TRANSFER',
    scenarioTag: 'payments',
    note: 'Bank line: "TRANSFER 14.00" - no reference',
  });
  const ordersAfter = await one<{ count: number }>(
    'SELECT count(*)::int AS count FROM orders WHERE bakery_id = $1',
    [ctx.bakeryId],
    client,
  );

  return {
    exact: { ...exact, ...exactPayment },
    over: { ...over, ...overPayment },
    candidateOrderId: candidate.orderId,
    unmatched,
    ordersBefore: ordersBefore!.count,
    ordersAfter: ordersAfter!.count,
  };
};

// --------------------------------------------------------------------------
// 5. Credit: $30 spent as $12 + $15 + $3, leaving $17 due on the third order
// --------------------------------------------------------------------------
const runCredit: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.sourdoughRoll); // $1.00 each
  const customerId = await customerIdByName(client, ctx.bakeryId, 'Cleo Spelt');
  const date = DATES.credit;

  const issued = await credit.issueCredit(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    customerId,
    amountCents: 3000,
    source: 'GOODWILL',
    note: 'Test credit',
    scenarioTag: 'credit',
  });

  const makeOrder = async (quantity: number, code: string) => {
    const result = await orders.createOrder(client, {
      bakeryId: ctx.bakeryId,
      actorUserId: ctx.actorUserId,
      customerId,
      channel: 'PICKUP',
      serviceDate: date,
      lines: [{ productId, quantity }],
      code,
      scenarioTag: 'credit',
    });
    if (!result.accepted) throw new Error('Credit scenario setup rejected');
    return result.order!.id as string;
  };

  const order12 = await makeOrder(12, 'CREDIT-12');
  const order15 = await makeOrder(15, 'CREDIT-15');
  const order20 = await makeOrder(20, 'CREDIT-20');

  const draws = [];
  for (const [orderId, amount] of [
    [order12, 1200],
    [order15, 1500],
    [order20, 300],
  ] as const) {
    draws.push(
      await credit.applyCredit(client, {
        bakeryId: ctx.bakeryId,
        actorUserId: ctx.actorUserId,
        creditId: issued.id as string,
        orderId,
        amountCents: amount,
      }),
    );
  }

  return {
    creditId: issued.id,
    orders: { order12, order15, order20 },
    draws,
    history: await credit.creditHistory(client, issued.id as string),
  };
};

// --------------------------------------------------------------------------
// 6. Shipping queue: no date -> October 1 -> October 2
// --------------------------------------------------------------------------
const runShipping: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.countryBlonde);
  const customerId = await customerIdByName(client, ctx.bakeryId, 'Esme Durum');

  const created = await orders.createOrder(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    customerId,
    channel: 'DOOR_TO_DOOR',
    serviceDate: null, // the customer picks nothing; the bakery decides
    lines: [{ productId, quantity: 4 }],
    code: 'SHIP-D2D',
    scenarioTag: 'shipping',
  });
  const orderId = created.order!.id as string;
  const initialStatus = created.order!.status;

  const first = await shipping.assignShippingDate(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    orderId,
    scheduledDate: DATES.shippingFirst,
    reason: 'First route slot offered',
  });

  const second = await shipping.assignShippingDate(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    orderId,
    scheduledDate: DATES.shippingSecond,
    reason: 'Van rerouted; moved one day later',
  });

  return {
    orderId,
    initialStatus,
    first,
    second,
    history: await shipping.shippingHistory(client, orderId),
  };
};

// --------------------------------------------------------------------------
// 7. Consignment: 10 out, 2 expected back, 0 returned
// --------------------------------------------------------------------------
const runConsignment: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.hearthMiche);
  const partnerId = await customerIdByName(client, ctx.bakeryId, 'Corner Cafe');

  const delivery = await consignment.createDelivery(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    partnerId,
    productId,
    deliveredUnits: 10,
    expectedReturnUnits: 2,
    deliveredOn: DATES.consignment,
    scenarioTag: 'consignment',
  });

  const recorded = await consignment.recordReturn(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    deliveryId: delivery.id as string,
    returnedUnits: 0,
    returnedOn: DATES.consignment,
  });

  return { deliveryId: delivery.id, ...recorded };
};

// --------------------------------------------------------------------------
// 8. Historical integrity: price $14 -> $15, recipe v1 -> v2
// --------------------------------------------------------------------------
const runHistory: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.heritageLoaf);
  const recipeId = await recipeIdForProduct(client, productId);
  const customerId = await customerIdByName(client, ctx.bakeryId, 'Ada Rye');
  const date = DATES.history;

  const priceBefore = await one<{ id: string; version: number; unit_price_cents: number }>(
    'SELECT id, version, unit_price_cents FROM product_prices WHERE product_id = $1 AND superseded_at IS NULL',
    [productId],
    client,
  );

  const order = await orders.createOrder(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    customerId,
    channel: 'PICKUP',
    serviceDate: date,
    lines: [{ productId, quantity: 2 }],
    code: 'HIST-ORDER',
    scenarioTag: 'history',
  });
  if (!order.accepted) throw new Error('History scenario setup rejected');

  const plan = await production.createPlan(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: date,
    maxMixerLoad: MAX_MIXER_LOAD,
    scenarioTag: 'history',
  });
  const run = await production.completeRun(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    planId: plan.plan.id,
    actualUnits: 2,
  });

  // Now change the world underneath them.
  const newPrice = await catalog.changePrice(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    unitPriceCents: (priceBefore!.unit_price_cents ?? 1400) + 100,
  });
  const newRecipe = await catalog.publishRecipeVersion(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    recipeId,
    ingredients: {
      flour_g: 1000,
      water_g: 760,
      salt_g: 21,
      levain_g: 200,
      version_note: 'v2 - wetter dough',
    },
    notes: 'Hydration raised',
  });

  return {
    productId,
    recipeId,
    orderId: order.order!.id,
    runId: run.runId,
    priceBefore: { version: priceBefore!.version, cents: priceBefore!.unit_price_cents },
    priceAfter: { version: newPrice.version, cents: newPrice.unit_price_cents },
    recipeVersionUsed: plan.recipeVersionId,
    recipeAfter: { version: newRecipe.version, id: newRecipe.id },
  };
};

// --------------------------------------------------------------------------
// 9. Tesla brain: recommend, do not act
// --------------------------------------------------------------------------
const runTesla: Runner = async (client, ctx) => {
  const productId = await productIdBySku(client, ctx.bakeryId, SKU.hearthMiche);
  const date = DATES.tesla;
  const names = ['Ada Rye', 'Ben Oat', 'Cleo Spelt'];
  const quantities = [25, 20, 15]; // 60 customer units

  for (const [i, quantity] of quantities.entries()) {
    const customerId = await customerIdByName(client, ctx.bakeryId, names[i]!);
    const result = await orders.createOrder(client, {
      bakeryId: ctx.bakeryId,
      actorUserId: ctx.actorUserId,
      customerId,
      channel: 'PICKUP',
      serviceDate: date,
      lines: [{ productId, quantity }],
      code: `TESLA-${i + 1}`,
      scenarioTag: 'tesla',
    });
    if (!result.accepted) throw new Error('Tesla scenario setup rejected');
  }

  const wholesale = await tesla.setWholesaleAllocation(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: date,
    units: 5,
    scenarioTag: 'tesla',
  });

  const plan = await production.createPlan(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: date,
    requiredUnits: 65,
    plannedUnits: 65,
    maxMixerLoad: MAX_MIXER_LOAD,
    scenarioTag: 'tesla',
  });

  const evaluation = await tesla.evaluateSupply(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    productId,
    serviceDate: date,
    actualProduction: 62,
    scenarioTag: 'tesla',
  });

  return {
    productId,
    serviceDate: date,
    planId: plan.plan.id,
    wholesaleVersion: wholesale.allocation.version,
    ...evaluation,
    note: 'Recommendation is PENDING. Accept or reject it from the console.',
  };
};

const RUNNERS: Record<ScenarioKey, Runner> = {
  availability: runAvailability,
  production: runProduction,
  failure: runFailure,
  payments: runPayments,
  credit: runCredit,
  shipping: runShipping,
  consignment: runConsignment,
  history: runHistory,
  tesla: runTesla,
};

export async function runScenario(
  client: PoolClient,
  ctx: ScenarioContext,
  scenario: ScenarioKey,
): Promise<Record<string, unknown>> {
  await resetScenario(client, { ...ctx, scenario });
  const result = await RUNNERS[scenario](client, ctx);

  await client.query(
    'INSERT INTO scenario_runs (bakery_id, scenario, actor_user_id, result) VALUES ($1,$2,$3,$4::jsonb)',
    [ctx.bakeryId, scenario, ctx.actorUserId, JSON.stringify(result)],
  );
  await writeAudit(client, {
    bakeryId: ctx.bakeryId,
    actorUserId: ctx.actorUserId,
    action: 'scenario.run',
    entityType: 'scenario',
    afterState: { scenario },
  });
  return result;
}
