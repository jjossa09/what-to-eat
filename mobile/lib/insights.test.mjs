import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_TEXT, loadInsights, localInsightsDate, mapInsights, withInsightsDeadline,
} from './insights.ts';

const A = 'aaaaaaaa-1111-4111-8111-000000000001';
const DATE = '2026-11-04';
const CATEGORIES = [{ id: 'pizza', name: 'Pizza' }, { id: 'thai', name: 'Thai' }];
const NAMES = [{ id: A, name: 'Alex' }];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'late'];

function response() {
  return {
    complete: true, cutoff_date: DATE, summary: { meal_count: 0, category_meal_count: 0 },
    companions: { companions: [], coverage: { unlinked_meals: 0, contradictory_company_meals: 0 } },
    price_by_slot: SLOTS.map((meal_slot) => ({ meal_slot, missing_meal_count: 0,
      levels: [1, 2, 3, 4].map((level) => ({ level, paid_count: 0, budget_count: 0 })) })),
    food_by_slot: SLOTS.map((meal_slot) => ({ meal_slot, category_meal_count: 0, leaders: [] })),
    distance_by_slot: SLOTS.map((meal_slot) => ({ meal_slot, measured_meal_count: 0, median_m: null })),
    top_categories: [], coverage: { unknown_slot_meals: 0, missing_price_meals: 0,
      backfill_distance_meals: 0, missing_distance_meals: 0 },
  };
}

function populated() {
  const body = response();
  body.summary = { meal_count: 5, category_meal_count: 4 };
  body.top_categories = [{ category_id: 'pizza', meal_count: 2 }, { category_id: 'thai', meal_count: 2 }];
  body.companions.companions = [companion(5)];
  body.food_by_slot[2].category_meal_count = 4;
  body.food_by_slot[2].leaders = body.top_categories;
  body.price_by_slot[2].levels[1].paid_count = 2;
  body.price_by_slot[2].levels[2].budget_count = 1;
  body.price_by_slot[2].missing_meal_count = 2;
  body.coverage.missing_price_meals = 2;
  body.coverage.missing_distance_meals = 2;
  body.distance_by_slot[2] = { meal_slot: 'dinner', measured_meal_count: 3, median_m: 3000 };
  return body;
}

function companion(count) {
  const categories = count ? [{ category_id: 'pizza', meal_count: 2 }, { category_id: 'thai', meal_count: 2 }] : [];
  return { companion_id: A, meal_count: count, category_meal_count: count ? 4 : 0,
    source_counts: { live: count, backfill: 0 },
    weekdays: [1, 2, 3, 4, 5, 6, 7].map((iso_day) => ({ iso_day, meal_count: iso_day === 1 ? count : 0 })),
    categories, leading_day_ids: count >= 5 ? [1] : null,
    leading_category_ids: count >= 5 ? ['pizza', 'thai'] : null,
    pattern_status: count >= 5 ? 'available' : 'insufficient_data' };
}

test('Insights joins saved companion names locally and sends only the date to the API', async () => {
  const calls = [];
  const state = await loadInsights(DATE, async (...args) => {
    calls.push(args);
    return populated();
  }, async () => NAMES, CATEGORIES);
  assert.deepEqual(calls, [[DATE]]);
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.cards.companions.groups[0].bars, [
    { id: A, label: 'Alex', value: 5, valueLabel: '5' },
  ]);
  assert.equal(state.cards.top.groups[0].bars[0].label, 'Pizza');
});

test('an ID without a saved name makes only the companion card unavailable', () => {
  const body = populated();
  const state = mapInsights(body, [], CATEGORIES);
  assert.equal(state.status, 'ready');
  assert.equal(state.cards.companions.unavailable, 'Names unavailable');
  assert.deepEqual(state.cards.companions.groups, []);
  for (const key of ['top', 'food', 'price', 'distance']) {
    assert.deepEqual(state.cards[key], mapInsights(body, NAMES, CATEGORIES).cards[key]);
  }
});

test('a failed saved-name read preserves all API numbers and isolates that card', async () => {
  const state = await loadInsights(DATE, async () => populated(),
    async () => { throw new Error('name read failed'); }, CATEGORIES);
  assert.equal(state.status, 'ready');
  assert.equal(state.cards.companions.unavailable, 'Names unavailable');
  assert.equal(state.cards.top.groups[0].bars[0].value, 2);
});

test('a 503 maps to unavailable with no zero-filled cards', async () => {
  const state = await loadInsights(DATE, async () => { throw new Error('503'); },
    async () => NAMES, CATEGORIES);
  assert.deepEqual(state, { status: 'unavailable' });
});

for (const phase of ['auth', 'fetch', 'body']) {
  test(`the Insights deadline includes a stalled ${phase} and returns unavailable`, async () => {
    let signal;
    const read = () => withInsightsDeadline(async (activeSignal) => {
      signal = activeSignal;
      const stages = { auth: async () => 'token', fetch: async () => ({ ok: true }),
        body: async () => populated() };
      stages[phase] = () => new Promise(() => {});
      await stages.auth();
      await stages.fetch();
      return await stages.body();
    }, 10);
    const state = await loadInsights(DATE, read, async () => NAMES, CATEGORIES);
    assert.deepEqual(state, { status: 'unavailable' });
    assert.equal(signal.aborted, true);
  });
}

test('a successful Insights body resolves within the deadline', async () => {
  const body = populated();
  assert.equal(await withInsightsDeadline(async () => body, 100), body);
});

test('complete false shows the honest note and preserves valid numbers', () => {
  const body = populated();
  body.complete = false;
  const state = mapInsights(body, NAMES, CATEGORIES);
  assert.equal(state.note, 'Some history is missing');
  assert.equal(state.cards.top.groups[0].bars[0].value, 2);
});

for (const [key, text] of Object.entries(EMPTY_TEXT)) {
  test(`the empty ${key} section supplies its card text: ${text}`, () => {
    const state = mapInsights(response(), [], CATEGORIES);
    assert.equal(state.cards[key].emptyText, text);
    assert.ok(state.cards[key].groups.every((g) => g.bars.length === 0));
    assert.equal(state.cards[key].unavailable, undefined);
  });
}

test('an incomplete empty result says no usable data, not no meals', () => {
  const body = response();
  assert.equal(mapInsights(body, [], []).emptyText, 'No meals yet');
  body.complete = false;
  const state = mapInsights(body, [], []);
  assert.equal(state.emptyText, 'No usable data');
  assert.equal(state.note, 'Some history is missing');
});

test('Profile most eaten preserves all tied API leaders without recounting meals', () => {
  const body = populated();
  body.top_categories.push({ category_id: 'burgers', meal_count: 1 });
  body.summary = { meal_count: 6, category_meal_count: 5 };
  assert.deepEqual(mapInsights(body, NAMES, CATEGORIES).mostEatenIds, ['pizza', 'thai']);
});

test('price bars keep paid evidence and budget evidence separate', () => {
  const state = mapInsights(populated(), NAMES, CATEGORIES);
  assert.equal(state.cards.price.note, 'Includes budgets.');
  const bars = state.cards.price.groups[0].bars;
  assert.deepEqual(bars[1], { id: '2', label: '$$', value: 2, budgetValue: 0,
    valueLabel: '2 paid · 0 budget' });
  assert.deepEqual(bars[2], { id: '3', label: '$$$', value: 0, budgetValue: 1,
    valueLabel: '0 paid · 1 budget' });
});

test('distance uses the API median, formats miles, and preserves a measured zero', () => {
  const body = populated();
  body.distance_by_slot[1] = { meal_slot: 'lunch', measured_meal_count: 1, median_m: 0 };
  const card = mapInsights(body, NAMES, CATEGORIES).cards.distance;
  assert.equal(card.note, 'Straight-line');
  assert.deepEqual(card.groups[0].bars.map((b) => b.valueLabel), ['0.0 mi · 1 meals', '1.9 mi · 3 meals']);
  assert.deepEqual(card.groups[0].bars.map((b) => b.value), [0, 3000]);
});

test('a saved companion with zero meals still has a named zero bar', () => {
  const body = response();
  body.companions.companions = [companion(0)];
  const bar = mapInsights(body, NAMES, CATEGORIES).cards.companions.groups[0].bars[0];
  assert.equal(bar.label, 'Alex');
  assert.equal(bar.value, 0);
});

test('as_of comes from local calendar fields instead of UTC conversion', () => {
  const localDate = { getFullYear: () => 2026, getMonth: () => 10, getDate: () => 4,
    toISOString: () => { throw new Error('must not use UTC'); } };
  assert.equal(localInsightsDate(localDate), DATE);
});
