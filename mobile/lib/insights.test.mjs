import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createOpeningMotion, EMPTY_TEXT, loadInsights, localInsightsDate, mapInsights,
  mealCount, motionConfig, openingRows, withInsightsDeadline,
} from './insights.ts';

const A = 'aaaaaaaa-1111-4111-8111-000000000001';
const DATE = '2026-11-04';
const CATEGORIES = [{ id: 'pizza', name: 'Pizza' }, { id: 'thai', name: 'Thai' }];
const NAMES = [{ id: A, name: 'Alex' }];
const SLOTS = ['breakfast', 'lunch', 'dinner', 'late'];

function response() {
  return {
    complete: true, cutoff_date: DATE, summary: { meal_count: 0, category_meal_count: 0 },
    companions: { companions: [], with_company_meal_count: 0,
      coverage: { unlinked_meals: 0, contradictory_company_meals: 0 } },
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
  body.companions.with_company_meal_count = 5;
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
    { id: A, label: 'Alex', value: 5, valueLabel: '5 of 5 meals' },
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

test('price slots are 100 percent stacks, keeping paid and budget evidence separate', () => {
  const state = mapInsights(populated(), NAMES, CATEGORIES);
  assert.equal(state.cards.price.note, 'Includes budgets');
  const dinner = state.cards.price.groups.find((g) => g.id === 'dinner');
  assert.equal(dinner.detail, '2 missing');
  assert.deepEqual(dinner.bars, []);
  assert.deepEqual(dinner.segments[1], { level: 2, label: '$$', paidCount: 2, budgetCount: 0,
    fraction: 2 / 3, paidFraction: 1, budgetFraction: 0 });
  assert.deepEqual(dinner.segments[2], { level: 3, label: '$$$', paidCount: 0, budgetCount: 1,
    fraction: 1 / 3, paidFraction: 0, budgetFraction: 1 });
  assert.equal(dinner.segments.reduce((n, s) => n + s.fraction, 0), 1);
});

test('distance uses the API median, formats miles, and preserves a measured zero', () => {
  const body = populated();
  body.distance_by_slot[1] = { meal_slot: 'lunch', measured_meal_count: 1, median_m: 0 };
  const card = mapInsights(body, NAMES, CATEGORIES).cards.distance;
  assert.equal(card.note, 'Straight-line');
  assert.deepEqual(card.groups[0].bars.map((b) => b.valueLabel), ['0.0 mi · 1 meal', '1.9 mi · 3 meals']);
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

test('empty food slots have one message and no redundant zero count', () => {
  const card = mapInsights(response(), [], CATEGORIES).cards.food;
  assert.equal(card.groups.length, 4);
  assert.ok(card.groups.every((g) => g.detail === undefined && g.bars.length === 0));
  assert.equal(card.emptyText, 'No food saved');
});

test('empty price slots remain visible with missing counts and no fabricated stack', () => {
  const body = response();
  body.summary.meal_count = 1;
  body.price_by_slot[1].missing_meal_count = 1;
  const card = mapInsights(body, [], CATEGORIES).cards.price;
  assert.equal(card.groups.length, 4);
  assert.equal(card.groups[1].detail, '1 missing');
  assert.ok(card.groups.every((g) => g.segments.every((s) => s.fraction === 0)));
  assert.equal(card.note, undefined);
});

test('mixed evidence within a price level retains its internal paid/budget proportions', () => {
  const body = populated();
  body.price_by_slot[2].levels[1].budget_count = 1;
  body.price_by_slot[2].levels[2].budget_count = 0;
  const segments = mapInsights(body, NAMES, CATEGORIES).cards.price.groups[2].segments;
  assert.equal(segments[1].fraction, 1);
  assert.equal(segments[1].paidFraction, 2 / 3);
  assert.equal(segments[1].budgetFraction, 1 / 3);
});

test('the budget note is absent when every price is paid evidence', () => {
  const body = populated();
  body.price_by_slot[2].levels[2].budget_count = 0;
  body.price_by_slot[2].missing_meal_count = 3;
  assert.equal(mapInsights(body, NAMES, CATEGORIES).cards.price.note, undefined);
});

test('meal counts use singular only for one, including food and distance labels', () => {
  assert.equal(mealCount(0), '0 meals');
  assert.equal(mealCount(1), '1 meal');
  assert.equal(mealCount(2), '2 meals');
  const body = response();
  body.summary = { meal_count: 1, category_meal_count: 1 };
  body.top_categories = [{ category_id: 'thai', meal_count: 1 }];
  body.food_by_slot[1] = { meal_slot: 'lunch', category_meal_count: 1, leaders: body.top_categories };
  const state = mapInsights(body, [], CATEGORIES);
  assert.equal(state.cards.top.note, '1 food meal');
  assert.equal(state.cards.top.groups[0].bars[0].valueLabel, '1 meal');
  assert.equal(state.cards.food.groups[1].detail, '1 food meal');
});

test('companion bars and ring use the API distinct count and visit total, never participation sums', () => {
  const body = populated();
  body.summary.meal_count = 26;
  body.companions.companions.push({ ...companion(5), companion_id: 'B' });
  body.companions.coverage.unlinked_meals = 21;
  const card = mapInsights(body, [...NAMES, { id: 'B', name: 'Sam' }], CATEGORIES).cards.companions;
  assert.deepEqual(card.groups[0].bars.map((b) => b.valueLabel), ['5 of 26 meals', '5 of 26 meals']);
  assert.deepEqual(card.ring, { value: 5, total: 26, fraction: 5 / 26,
    label: 'With company: 5 of 26 meals' });
});

test('the company ring handles no meals and a single meal without division by zero', () => {
  const body = response();
  const empty = mapInsights(body, [], []).cards.companions.ring;
  assert.deepEqual(empty, { value: 0, total: 0, fraction: 0, label: 'With company: 0 of 0 meals' });
  body.summary.meal_count = 1;
  body.companions.with_company_meal_count = 1;
  body.companions.companions = [{ ...companion(0), meal_count: 1,
    source_counts: { live: 1, backfill: 0 }, weekdays: companion(0).weekdays.map((d) =>
      ({ ...d, meal_count: d.iso_day === 1 ? 1 : 0 })) }];
  const card = mapInsights(body, NAMES, []).cards.companions;
  assert.equal(card.ring.label, 'With company: 1 of 1 meal');
  assert.equal(card.ring.fraction, 1);
  assert.equal(card.groups[0].bars[0].valueLabel, '1 of 1 meal');
});

test('a missing API company count is unavailable rather than invented as zero', async () => {
  const body = populated();
  delete body.companions.with_company_meal_count;
  assert.deepEqual(await loadInsights(DATE, async () => body, async () => NAMES, CATEGORIES),
    { status: 'unavailable' });
});

function fakeMotion() {
  const calls = [];
  const motion = createOpeningMotion({
    value: (initial) => ({ current: initial }),
    set: (value, final) => { value.current = final; },
    animate: (value, config) => {
      const call = { value, config, stopped: false };
      calls.push(call);
      return () => { call.stopped = true; };
    },
  });
  return { motion, calls };
}

test('opening uses 400 ms bars, 50 ms stagger, and one 500 ms ring', () => {
  const rows = openingRows(mapInsights(populated(), NAMES, CATEGORIES).cards);
  assert.deepEqual(rows.filter((r) => r.id.startsWith('price:')),
    [{ id: 'price:dinner', kind: 'bar', index: 0 }]);
  const { motion, calls } = fakeMotion();
  motion.begin(rows, false);
  const bars = calls.filter((c) => c.config.useNativeDriver);
  assert.ok(bars.length > 0);
  assert.ok(bars.every((c) => c.config.duration === 400));
  assert.deepEqual(bars.slice(0, 2).map((c) => c.config.delay), [0, 50]);
  assert.equal(calls.filter((c) => c.config.duration === 500).length, 1);
  assert.equal(calls.find((c) => c.config.duration === 500).config.useNativeDriver, false);
});

test('reduce motion shows final values immediately without starting any animation', () => {
  const rows = openingRows(mapInsights(populated(), NAMES, CATEGORIES).cards);
  const { motion, calls } = fakeMotion();
  for (const row of rows) motion.value(row.id);
  motion.begin(rows, true);
  assert.equal(calls.length, 0);
  assert.ok(rows.every((r) => motion.value(r.id).current === 1));
  assert.deepEqual(motionConfig({ id: 'bar', kind: 'bar', index: 3 }, true),
    { initial: 1, duration: 0, delay: 0, useNativeDriver: true });
});

test('scroll and refresh do not replay; newly refreshed bars start at final values', () => {
  const rows = openingRows(mapInsights(populated(), NAMES, CATEGORIES).cards);
  const { motion, calls } = fakeMotion();
  motion.begin(rows, false);
  const count = calls.length;
  const first = motion.value(rows[0].id);
  motion.begin(rows, false);
  motion.begin([...rows, { id: 'new-category', kind: 'bar', index: 3 }], false);
  assert.equal(calls.length, count);
  assert.equal(motion.value(rows[0].id), first);
  assert.equal(motion.value('new-category').current, 1);
  const reopened = fakeMotion();
  reopened.motion.begin(rows, false);
  assert.equal(reopened.calls.length, count);
});

test('enabling reduce motion stops active animations at final values without replay', () => {
  const rows = openingRows(mapInsights(populated(), NAMES, CATEGORIES).cards);
  const { motion, calls } = fakeMotion();
  motion.begin(rows, false);
  motion.begin(rows, true);
  assert.ok(calls.every((c) => c.stopped));
  assert.ok(rows.every((r) => motion.value(r.id).current === 1));
  const count = calls.length;
  motion.begin(rows, false);
  assert.equal(calls.length, count);
});
