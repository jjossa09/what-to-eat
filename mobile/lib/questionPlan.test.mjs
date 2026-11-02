// Run: node --test mobile/lib/questionPlan.test.mjs  (Node 22.18+ strips the TypeScript types.)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { budgetPick, planPrefill, traceOf } from './questionPlan.ts';

// The exact body POST /questions/plan returned for a history like the device test (confident
// Chinese at $, slot_weekend), captured from the API through its test client.
const REAL_PLAN = JSON.parse(
  '{"history_used":true,"meal_slot":"dinner","questions":[' +
    '{"key":"distance","weak":true,"prefill":null,"predicted":null,"top_prob":0.5,"meals":0,"level":"none"},' +
    '{"key":"craving","weak":false,"prefill":"chinese","predicted":"chinese","top_prob":0.9712,"meals":9,"level":"slot_weekend"},' +
    '{"key":"budget","weak":false,"prefill":1,"predicted":1,"top_prob":0.9737,"meals":9,"level":"slot_weekend"}]}',
);
// Category ids as loadCategories() returns them (the seeded ids; Chinese is 'chinese').
const CATEGORY_IDS = new Set(['burgers', 'pizza', 'mexican', 'chinese', 'thai']);
// The budget chips' values (Chat.tsx BUDGETS).
const BUDGET_CHIPS = [1, 2, 3, 4];

test('the real plan shape pre-fills craving and budget with the chip values', () => {
  const pre = planPrefill(REAL_PLAN.questions, CATEGORY_IDS);
  assert.deepEqual(pre, { craving: 'chinese', budget: 1 });
  assert.equal(typeof pre.budget, 'number');
});

test('the real plan selects exactly the $ chip, even with a quiz budget of $$', () => {
  const pick = budgetPick(planPrefill(REAL_PLAN.questions, CATEGORY_IDS), 2);
  assert.deepEqual(BUDGET_CHIPS.filter((level) => level === pick), [1]);
});

test('the real plan selects the Chinese craving chip by id', () => {
  const pre = planPrefill(REAL_PLAN.questions, CATEGORY_IDS);
  assert.ok(CATEGORY_IDS.has(pre.craving));
});

test('no plan budget falls back to the quiz budget', () => {
  assert.equal(budgetPick({}, 2), 2);
  assert.equal(budgetPick({}, null), null);
});

test('values that match no chip are dropped, never kept', () => {
  const questions = [
    { key: 'craving', prefill: 'Chinese' }, // a label, not the id
    { key: 'budget', prefill: '1' }, // a string, not the level
    { key: 'distance', prefill: 5000 }, // not a chip radius
  ];
  assert.deepEqual(planPrefill(questions, CATEGORY_IDS), {});
  assert.deepEqual(planPrefill([{ key: 'budget', prefill: 5 }], CATEGORY_IDS), {});
  assert.deepEqual(planPrefill([{ key: 'budget', prefill: 1.5 }], CATEGORY_IDS), {});
});

test('an unknown category id is dropped', () => {
  assert.deepEqual(planPrefill([{ key: 'craving', prefill: 'ramen' }], CATEGORY_IDS), {});
});

test('a weak plan (all null) pre-fills nothing', () => {
  const weak = REAL_PLAN.questions.map((q) => ({ ...q, prefill: null }));
  assert.deepEqual(planPrefill(weak, CATEGORY_IDS), {});
  assert.deepEqual(planPrefill(undefined, CATEGORY_IDS), {});
});

test('the trace lists every question, null when nothing was pre-selected', () => {
  assert.deepEqual(traceOf({ craving: 'chinese', budget: 1 }), {
    craving: 'chinese',
    budget: 1,
    distance: null,
  });
  assert.deepEqual(traceOf({}), { craving: null, budget: null, distance: null });
});
