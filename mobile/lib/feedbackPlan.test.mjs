// Run: node --test mobile/lib/feedbackPlan.test.mjs  (Node 22.18+ strips the TypeScript types.)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resumePlan } from './feedbackPlan.ts';

const base = { went: true, ateAnswered: false, stars: null, priceTap: null };

test('no answer yet asks Did you go?', () => {
  assert.deepEqual(resumePlan({ ...base, went: null }), { kind: 'went' });
});

test('went = false or rated asks nothing', () => {
  assert.deepEqual(resumePlan({ ...base, went: false }), { kind: 'none' });
  assert.deepEqual(resumePlan({ ...base, ateAnswered: true, stars: 4 }), { kind: 'none' });
});

test('went only: food, stars, then price', () => {
  assert.deepEqual(resumePlan(base), { kind: 'food', askPrice: true });
});

test('food answered (in the prompt or by an edit): starts at stars', () => {
  assert.deepEqual(resumePlan({ ...base, ateAnswered: true }), { kind: 'stars', askPrice: true });
});

test('price set by an edit before stars: price is not asked again', () => {
  assert.deepEqual(resumePlan({ ...base, ateAnswered: true, priceTap: 1 }), { kind: 'stars', askPrice: false });
  assert.deepEqual(resumePlan({ ...base, priceTap: 3 }), { kind: 'food', askPrice: false });
});

test('stars set by an edit ends the prompt, even with no food answer', () => {
  assert.deepEqual(resumePlan({ ...base, stars: 5 }), { kind: 'none' });
});
