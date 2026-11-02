// Run: node --test mobile/lib/questionPlan.test.mjs  (Node 22.18+ strips the TypeScript types.)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { budgetPick, companySelection, matchCompany, newSearchPlan, planPrefill, skippedAnswers, traceOf } from './questionPlan.ts';

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


const A = 'aaaaaaaa-1111-4111-8111-000000000001';
const B = 'bbbbbbbb-2222-4222-8222-000000000002';
const C = 'cccccccc-3333-4333-8333-000000000003';
const D = 'dddddddd-4444-4444-8444-000000000004';
const PEOPLE = [{ id: A, name: 'Alex' }, { id: B, name: 'Sam' },
  { id: C, name: 'Andrea' }, { id: D, name: 'Kim' }];
const IDS = new Set(PEOPLE.map((c) => c.id));

test('company matches an exact name', () => {
  assert.deepEqual(matchCompany('Alex', PEOPLE), [A]);
});
test('company matches names ignoring case and surrounding whitespace', () => {
  assert.deepEqual(matchCompany('  aLeX  ', PEOPLE), [A]);
});
test('company matches comma groups', () => {
  assert.deepEqual(matchCompany('Sam, Alex', PEOPLE), [A, B]);
});
test('company matches ampersand groups', () => {
  assert.deepEqual(matchCompany('Alex & Sam', PEOPLE), [A, B]);
});
test('company matches and groups', () => {
  assert.deepEqual(matchCompany('Alex and Sam', PEOPLE), [A, B]);
});
test('company matches mixed separators', () => {
  assert.deepEqual(matchCompany('Alex, Sam & Andrea and Kim', PEOPLE), [A, B, C, D]);
});
test('company never splits and inside a name', () => {
  assert.deepEqual(matchCompany('Andrea and Sam', PEOPLE), [B, C]);
});
test('an exact Jack and Jill name wins over splitting it', () => {
  const people = [{ id: A, name: 'Jack and Jill' }, { id: B, name: 'Jack' }, { id: C, name: 'Jill' }];
  assert.deepEqual(matchCompany('Jack and Jill', people), [A]);
});
test('ambiguous Alex is never guessed, alone or in a group', () => {
  const people = [...PEOPLE, { id: 'another-id', name: 'alex' }];
  assert.equal(matchCompany('Alex', people), null);
  assert.equal(matchCompany('Sam and Alex', people), null);
});
test('unknown names reject the whole group', () => {
  assert.equal(matchCompany('Taylor', PEOPLE), null);
  assert.equal(matchCompany('Alex and Taylor', PEOPLE), null);
});
test('repeated companions are rejected', () => {
  assert.equal(matchCompany('Alex, alex', PEOPLE), null);
});
test('dangling and consecutive separators are rejected', () => {
  for (const text of ['Alex,', ',Alex', 'Alex &', 'and Alex', 'Alex and', 'Alex,,Sam']) {
    assert.equal(matchCompany(text, PEOPLE), null, text);
  }
});
test('solo words are matched locally', () => {
  for (const text of ['solo', 'alone', 'just me', ' SOLO ']) {
    assert.equal(matchCompany(text, PEOPLE), 'solo');
  }
});
test('empty company text is unknown', () => {
  assert.equal(matchCompany('', PEOPLE), null);
  assert.equal(matchCompany('  ', PEOPLE), null);
});
test('unmatched punctuation is not stripped to guess a name', () => {
  assert.equal(matchCompany('Alex!', PEOPLE), null);
  assert.equal(matchCompany('Alex; Sam', PEOPLE), null);
});
test('company selections accept known ids and lowercase solo only', () => {
  assert.deepEqual(companySelection([B, A], IDS), [A, B]);
  assert.equal(companySelection('solo', IDS), 'solo');
  assert.equal(companySelection('Solo', IDS), null);
  assert.equal(companySelection([A, 'unknown'], IDS), null);
});
test('company selections reject empty, duplicate, and non-array groups', () => {
  for (const value of [[], [A, A], A, null, undefined, {}, 1, [1], ['Alex']]) {
    assert.equal(companySelection(value, IDS), null);
  }
});

test('a weak skipped company is never applied', () => {
  for (const predicted of [[A], 'solo']) {
    assert.deepEqual(skippedAnswers({ key: 'company', weak: true, predicted }, CATEGORY_IDS, IDS), {});
  }
});
test('a confident skipped company is applied', () => {
  assert.deepEqual(skippedAnswers({ key: 'company', weak: false, predicted: [A] }, CATEGORY_IDS, IDS),
    { company: [A] });
  assert.deepEqual(skippedAnswers({ key: 'company', weak: false, predicted: 'solo' }, CATEGORY_IDS, IDS),
    { company: 'solo' });
});

function question(key, top, meals = 8, predicted = null) {
  const weak = top < 0.4 || meals < 5;
  return { key, top_prob: top, meals, weak, predicted, prefill: weak ? null : predicted };
}
function searchPlan(budget, company, distance = question('distance', 0.5, 0)) {
  return newSearchPlan({
    questions: [budget, distance, company],
    skipped: question('craving', 0.99, 10, 'chinese'),
  });
}

test('new search reserves craving and preserves the new plan pre-selections', () => {
  const plan = searchPlan(question('budget', 0.8, 8, 1), question('company', 0.7, 8, [A]));
  assert.deepEqual(plan.questions.map((q) => q.key), ['craving', 'distance', 'company']);
  assert.equal(plan.skipped.key, 'budget');
  assert.deepEqual(plan.questions.find((q) => q.key === 'company').prefill, [A]);
  assert.equal(skippedAnswers(plan.skipped, CATEGORY_IDS, IDS).budget, 1);
});
test('new search skips budget on a confidence tie', () => {
  const plan = searchPlan(question('budget', 0.8), question('company', 0.8));
  assert.equal(plan.skipped.key, 'budget');
});
test('new search skips company as unknown when the remaining questions are weak', () => {
  const plan = searchPlan(question('budget', 0.9, 3), question('company', 0.3, 8, [A]));
  assert.deepEqual(plan.questions.map((q) => q.key), ['craving', 'budget', 'distance']);
  assert.equal(plan.skipped.predicted, null);
  assert.equal(plan.skipped.reason, 'skipped_weak');
  assert.deepEqual(skippedAnswers(plan.skipped, CATEGORY_IDS, IDS), {});
});
test('new search never skips a weak distance despite high probability', () => {
  const plan = searchPlan(question('budget', 0.6), question('company', 0.3), question('distance', 0.99, 4));
  assert.equal(plan.skipped.key, 'budget');
  assert.ok(plan.questions.some((q) => q.key === 'distance'));
});
test('new search may skip a confident distance', () => {
  const plan = searchPlan(question('budget', 0.6), question('company', 0.3), question('distance', 0.9, 5, 15000));
  assert.equal(plan.skipped.key, 'distance');
});
test('new search may skip confident company', () => {
  const plan = searchPlan(question('budget', 0.6), question('company', 0.9, 8, [A]));
  assert.equal(plan.skipped.key, 'company');
  assert.deepEqual(plan.skipped.predicted, [A]);
});
test('new search without company keeps all three answers and skips nothing', () => {
  const plan = newSearchPlan({ questions: [question('distance', 0.5, 0),
    question('budget', 0.9, 8, 1), question('craving', 0.7, 8, 'thai')], skipped: null });
  assert.deepEqual(plan.questions.map((q) => q.key), ['craving', 'distance', 'budget']);
  assert.equal(plan.skipped, null);
});


test('new search preserves the server skip when rounded probabilities appear tied', () => {
  const skipped = question('company', 0.8, 8, [A]);
  const plan = newSearchPlan({ questions: [question('craving', 0.99),
    question('distance', 0.5, 0), question('budget', 0.8, 8, 1)], skipped });
  assert.equal(plan.skipped.key, 'company');
  assert.equal(plan.questions.length, 3);
});
