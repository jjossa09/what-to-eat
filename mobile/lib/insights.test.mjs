import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createOpeningMotion, EMPTY_TEXT, loadInsights, localInsightsDate, mapInsights,
  defaultDistanceSlot, formatMiles, mealCount, motionConfig, openingRows, timelineGeometry,
  timelineRows, withInsightsDeadline,
} from './insights.ts';
import { chart, colors } from '../theme.ts';

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
    distance_by_slot: SLOTS.map((meal_slot) => ({ meal_slot, measured_meal_count: 0, median_m: null, points: [] })),
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
  body.distance_by_slot[2] = { meal_slot: 'dinner', measured_meal_count: 3, median_m: 3000,
    points: [{ eaten_on: '2026-11-01', distance_m: 1000 },
      { eaten_on: '2026-11-02', distance_m: 3000 }, { eaten_on: '2026-11-04', distance_m: 8000 }] };
  body.companions.companions[0].weekdays = [1, 2, 3, 4, 5, 6, 7].map((iso_day) => ({ iso_day,
    meal_count: ({ 1: 3, 3: 1, 7: 1 })[iso_day] ?? 0 }));
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
  assert.equal(state.cards.price.note, undefined);
  const dinner = state.cards.price.groups.find((g) => g.id === 'dinner');
  assert.equal(dinner.detail, '2 missing');
  assert.deepEqual(dinner.bars, []);
  assert.deepEqual(dinner.segments[1], { level: 2, label: '$$', paidCount: 2, budgetCount: 0,
    fraction: 2 / 3 });
  assert.deepEqual(dinner.segments[2], { level: 3, label: '$$$', paidCount: 0, budgetCount: 1,
    fraction: 1 / 3 });
  assert.equal(dinner.budgetNote, '1 from budgets');
  assert.ok(state.cards.price.groups.filter((g) => g.id !== 'dinner').every((g) => g.budgetNote === undefined));
  assert.equal(dinner.segments.reduce((n, s) => n + s.fraction, 0), 1);
});

test('distance uses the API median, formats miles, and preserves a measured zero', () => {
  const body = populated();
  body.distance_by_slot[1] = { meal_slot: 'lunch', measured_meal_count: 1, median_m: 0,
    points: [{ eaten_on: '2026-11-02', distance_m: 0 }] };
  const card = mapInsights(body, NAMES, CATEGORIES).cards.distance;
  assert.equal(card.note, 'Straight-line');
  assert.equal(card.timeline[1].median_m, 0);
  assert.equal(card.timeline[2].median_m, 3000);
  assert.equal(card.timeline[1].points[0].distance_m, 0);
  assert.equal(formatMiles(card.timeline[1].median_m), '0 mi');
  assert.equal(formatMiles(card.timeline[2].median_m), '1.9 mi');
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

test('mixed evidence uses a solid level segment with a separate per-slot budget count', () => {
  const body = populated();
  body.price_by_slot[2].levels[1].budget_count = 1;
  body.price_by_slot[2].levels[2].budget_count = 0;
  const group = mapInsights(body, NAMES, CATEGORIES).cards.price.groups[2];
  const segments = group.segments;
  assert.equal(segments[1].fraction, 1);
  assert.equal(segments[1].paidCount, 2);
  assert.equal(segments[1].budgetCount, 1);
  assert.equal(group.budgetNote, '1 from budgets');
});

test('the budget note is absent when every price is paid evidence', () => {
  const body = populated();
  body.price_by_slot[2].levels[2].budget_count = 0;
  body.price_by_slot[2].missing_meal_count = 3;
  const card = mapInsights(body, NAMES, CATEGORIES).cards.price;
  assert.equal(card.note, undefined);
  assert.ok(card.groups.every((g) => g.budgetNote === undefined));
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
  const bars = calls.filter((_, i) => rows[i].kind === 'bar');
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

test('distance defaults to the most points, with canonical slot order breaking ties', () => {
  const slots = mapInsights(populated(), NAMES, CATEGORIES).cards.distance.timeline;
  assert.equal(defaultDistanceSlot(slots), 'dinner');
  const tied = slots.map((s) => ({ ...s, points: slots[2].points }));
  assert.equal(defaultDistanceSlot(tied), 'breakfast');
  assert.equal(defaultDistanceSlot([...tied].reverse()), 'breakfast');
  assert.equal(defaultDistanceSlot(mapInsights(response(), [], []).cards.distance.timeline), 'breakfast');
});

test('timeline uses actual calendar-date spacing and keeps the API median', () => {
  const slot = mapInsights(populated(), NAMES, CATEGORIES).cards.distance.timeline[2];
  const geometry = timelineGeometry(slot);
  assert.deepEqual(geometry.points.map((p) => p.x), [0, 1 / 3, 1]);
  assert.deepEqual(geometry.points.map((p) => p.y), [0.875, 0.625, 0]);
  assert.equal(geometry.maximum, 8000);
  assert.equal(geometry.medianY, 0.625);
  assert.equal(geometry.message, undefined);
});

test('one date is centered, single points ask for two meals, and zero stays on the baseline', () => {
  const single = { id: 'lunch', label: 'Lunch', median_m: 0, measured_meal_count: 1,
    points: [{ eaten_on: DATE, distance_m: 0 }] };
  const geometry = timelineGeometry(single);
  assert.equal(geometry.points[0].x, 0.5);
  assert.equal(geometry.points[0].y, 1);
  assert.equal(geometry.maximum, 0);
  assert.equal(geometry.message, '2 meals needed for a trend');
  const sameDay = timelineGeometry({ ...single, measured_meal_count: 2, median_m: 500,
    points: [...single.points, { eaten_on: DATE, distance_m: 1000 }] });
  assert.deepEqual(sameDay.points.map((p) => p.x), [0.5, 0.5]);
  assert.equal(sameDay.message, undefined);
  assert.equal(formatMiles(1), '<0.1 mi');
});

test('empty timelines have no fabricated points, median or positive maximum', () => {
  const slot = mapInsights(response(), [], []).cards.distance.timeline[0];
  const geometry = timelineGeometry(slot);
  assert.equal(slot.median_m, null);
  assert.deepEqual(geometry.points, []);
  assert.equal(geometry.maximum, 0);
  assert.equal(geometry.message, 'No distances yet');
});

test('timeline phases are axes, trace, Typical; slot switches replay only those phases', () => {
  const cards = mapInsights(populated(), NAMES, CATEGORIES).cards;
  const rows = openingRows(cards);
  const { motion, calls } = fakeMotion();
  motion.begin(rows, false);
  const count = calls.length;
  motion.switchTimeline(3, false);
  assert.deepEqual(calls.slice(count).map((c) => c.config), [
    { initial: 0, duration: 200, delay: 0, useNativeDriver: true },
    { initial: 0, duration: 600, delay: 200, useNativeDriver: false },
    { initial: 0, duration: 200, delay: 800, useNativeDriver: true },
  ]);
  motion.begin(rows, false); // Refreshed data preserves both selection and progress.
  assert.equal(calls.length, count + 3);
  motion.switchTimeline(1, false);
  assert.deepEqual(calls.slice(-2).map((c) => c.config.delay), [0, 200]);
  const beforeEmpty = calls.length;
  motion.switchTimeline(0, false);
  assert.equal(calls.length, beforeEmpty);
  assert.equal(motion.value('distance:trace').current, 1);
});

test('Reduce Motion makes every timeline phase final on opening and slot changes', () => {
  const { motion, calls } = fakeMotion();
  const rows = timelineRows(3);
  motion.begin(rows, true);
  motion.switchTimeline(4, true);
  assert.equal(calls.length, 0);
  assert.ok(rows.every((r) => motion.value(r.id).current === 1));
  assert.ok(rows.every((r) => motionConfig(r, true).duration === 0));
});

test('budgets are reported per slot with no global note or opacity-based fractions', () => {
  const body = populated();
  body.price_by_slot[2].levels[1].paid_count = 1;
  body.price_by_slot[2].levels[1].budget_count = 1;
  const card = mapInsights(body, NAMES, CATEGORIES).cards.price;
  assert.equal(card.note, undefined);
  assert.equal(card.groups[2].budgetNote, '2 from budgets');
  assert.ok(card.groups.filter((g) => g.id !== 'dinner').every((g) => !g.budgetNote));
  assert.ok(card.groups.every((g) => g.segments.every((s) => !('budgetFraction' in s))));
});

const CATEGORY_IDS = [...readFileSync(new URL('../../api/app/categories.py', import.meta.url), 'utf8')
  .match(/CATEGORY_IDS[^=]*= \(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

function channels(hex) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
}
function linear(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function luminance(c) { return c.map(linear).reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0); }
function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
function blend(a, b, alpha) { return a.map((v, i) => alpha * v + (1 - alpha) * b[i]); }
function lab(hex) {
  const [r, g, b] = channels(hex).map(linear);
  const xyz = [(0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883];
  const [x, y, z] = xyz.map((v) => v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// CIEDE2000, independently checked against the published Sharma reference pair below.
function deltaE00([l1, a1, b1], [l2, a2, b2]) {
  const rad = (d) => d * Math.PI / 180;
  const cos = (d) => Math.cos(rad(d));
  const sin = (d) => Math.sin(rad(d));
  const cm = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1), cp2 = Math.hypot(ap2, b2);
  const hp1 = (Math.atan2(b1, ap1) * 180 / Math.PI + 360) % 360;
  const hp2 = (Math.atan2(b2, ap2) * 180 / Math.PI + 360) % 360;
  let dh = hp2 - hp1;
  if (cp1 * cp2 === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dhp = 2 * Math.sqrt(cp1 * cp2) * sin(dh / 2);
  const lm = (l1 + l2) / 2, cpm = (cp1 + cp2) / 2;
  let hm;
  if (cp1 * cp2 === 0) hm = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hm = (hp1 + hp2) / 2;
  else if (hp1 + hp2 < 360) hm = (hp1 + hp2 + 360) / 2;
  else hm = (hp1 + hp2 - 360) / 2;
  const t = 1 - 0.17 * cos(hm - 30) + 0.24 * cos(2 * hm)
    + 0.32 * cos(3 * hm + 6) - 0.20 * cos(4 * hm - 63);
  const sl = 1 + 0.015 * (lm - 50) ** 2 / Math.sqrt(20 + (lm - 50) ** 2);
  const sc = 1 + 0.045 * cpm, sh = 1 + 0.015 * cpm * t;
  const rt = -2 * Math.sqrt(cpm ** 7 / (cpm ** 7 + 25 ** 7))
    * sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)));
  const dl = (l2 - l1) / sl, dc = (cp2 - cp1) / sc, dH = dhp / sh;
  return Math.sqrt(dl * dl + dc * dc + dH * dH + rt * dc * dH);
}

test('the CIEDE2000 check matches a published reference pair', () => {
  assert.ok(Math.abs(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 0.0001);
});

test('all 25 category IDs have unique fixed colors shared by both category charts', () => {
  assert.equal(CATEGORY_IDS.length, 25);
  assert.deepEqual(Object.keys(chart.categories), CATEGORY_IDS);
  assert.equal(new Set(Object.values(chart.categories)).size, 25);
  const body = response();
  body.summary = { meal_count: 25, category_meal_count: 25 };
  body.top_categories = CATEGORY_IDS.map((category_id) => ({ category_id, meal_count: 1 }));
  body.food_by_slot[2] = { meal_slot: 'dinner', category_meal_count: 25, leaders: body.top_categories };
  const cards = mapInsights(body, [], CATEGORIES, chart.categories).cards;
  assert.deepEqual(cards.top.groups[0].bars.map((b) => b.color),
    cards.food.groups[2].bars.map((b) => b.color));
  for (const bar of cards.top.groups[0].bars) assert.equal(bar.color, chart.categories[bar.id]);
});

test('canonical neighbors stay separated by deltaE00 25 and every common-category pair reaches 20', () => {
  for (let i = 1; i < CATEGORY_IDS.length; i++) {
    assert.ok(deltaE00(lab(chart.categories[CATEGORY_IDS[i - 1]]), lab(chart.categories[CATEGORY_IDS[i]])) >= 25);
  }
  const common = ['chinese', 'mexican', 'chicken_wings', 'burgers', 'sandwiches'];
  for (let i = 0; i < common.length; i++) {
    for (const other of common.slice(i + 1)) {
      const difference = deltaE00(lab(chart.categories[common[i]]), lab(chart.categories[other]));
      assert.ok(difference >= 20, `${common[i]} vs ${other}: ${difference}`);
    }
  }
});

test('all chart marks meet 3:1 contrast and price levels deepen from light to dark', () => {
  const glass = colors.glass.match(/[\d.]+/g).map(Number);
  const white = glass.slice(0, 3).map((v) => v / 255);
  const backgrounds = [...colors.gradient.map((c) => blend(white, channels(c), glass[3])), white];
  for (const bg of backgrounds) {
    for (const c of [...Object.values(chart.categories), ...chart.price, chart.accent, chart.neutral]) {
      assert.ok(contrast(channels(c), bg) >= 3, `${c} contrast below 3`);
    }
    assert.ok(contrast(channels(chart.accent), blend(channels(chart.accent), bg, chart.areaOpacity)) >= 3);
  }
  for (let i = 1; i < chart.price.length; i++) {
    assert.ok(luminance(channels(chart.price[i - 1])) > luminance(channels(chart.price[i])));
  }
});
