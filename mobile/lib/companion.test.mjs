import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { changedLine, companionIds, dispatch, emptySurvey, privateMessage, resolveDate, validInterpretation } from './companion.ts';

function actions() {
  const source = readFileSync(new URL('./companionActions.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const requests = [];
  const deps = { './api': { deviceTimezone: () => 'America/New_York', companionCall: async (path, body) => {
    requests.push({ path, body });
    return path.endsWith('prepare') ? { id: 'synthetic-action', state: 'pending', arguments: body.arguments } : { status: 'saved' };
  } }, './companion': { companionIds, resolveDate } };
  new Function('require', 'module', 'exports', output)((key) => deps[key], module, module.exports);
  return { ...module.exports, requests };
}
const people = [{ id: 'a', name: 'Alex' }, { id: 'b', name: 'María José' }];

test('mixed survey, meal and history messages redact saved companion names before parsing', () => {
  for (const text of ['Chinese with Alex', 'I had wings with ALEX yesterday', 'Show meals with María José']) {
    const safe = privateMessage(text, people);
    assert.ok(!/alex|maría josé/i.test(safe.text));
    assert.deepEqual(safe.companion_refs, ['companion_1', 'companion_2']);
  }
});
test('privacy matching preserves words and rejects ambiguous companion associations', () => {
  assert.equal(privateMessage('Alexander wants pizza', people).text, 'Alexander wants pizza');
  const ambiguous = privateMessage('with Alex', [...people, { id: 'c', name: 'Alex' }]);
  assert.equal(ambiguous.text, 'with companion_ambiguous');
  assert.equal(companionIds(['companion_ambiguous'], people), null);
  assert.equal(companionIds(['companion_99'], people), null);
  assert.deepEqual(companionIds(['companion_2'], people), ['b']);
});
test('new conversations share no survey objects, exclusions, answers or questions', () => {
  const first = emptySurvey(); first.exclusions.push('chinese'); first.budget.value = 1;
  const next = emptySurvey();
  assert.deepEqual(next.exclusions, []); assert.equal(next.budget.value, null);
  assert.deepEqual(next.asked, []); assert.notEqual(first.craving, first.budget);
});
test('action precedence exposes only one side effect and requires explicit handling of the second', () => {
  const intents = [{ type: 'recommend_now' }, { type: 'find_place', name: 'Wingstop' },
    { type: 'log_meal' }, { type: 'rate_meal' }, { type: 'confirm' }];
  const result = dispatch(intents);
  assert.equal(result.confirmation.type, 'confirm'); assert.equal(result.effect.type, 'log_meal');
  assert.equal(result.second, 'rate_meal'); assert.equal(result.reads.length, 1); assert.equal(result.recommend, true);
});
test('confirmation text is derived from actual validated changes, never a model call', () => {
  const before = emptySurvey(); const after = emptySurvey();
  after.craving = { value: 'italian', status: 'confirmed', source: 'typed', turn: 1 };
  after.budget = { value: 1, status: 'confirmed', source: 'typed', turn: 1 };
  assert.equal(changedLine(before, after, new Map([['italian', 'Italian']])), 'Got it: Italian, $.');
  after.craving.status = 'predicted'; after.budget.status = 'predicted';
  assert.equal(changedLine(before, after, new Map()), null);
});
test('invalid patch values and malformed actions fail mobile validation', () => {
  const valid = { understood: true, intents: [{ type: 'recommend_now' }], patch: {} };
  assert.equal(validInterpretation(valid), true);
  for (const patch of [{ budget: { status: 'confirmed', value: true } },
    { craving: { status: 'confirmed', value: 'invented' } }, { future_action: 'save' }]) {
    assert.equal(validInterpretation({ ...valid, patch }, new Set(['italian'])), false);
  }
  assert.equal(validInterpretation({ ...valid, intents: [{ type: 'log_meal' }] }), false);
  assert.equal(validInterpretation({ ...valid, intents: [{ type: 'history_query', range: 'all', chart_id: 'fake', slot: null }] }), false);
});
test('weekday meal references stay unresolved and calendar yesterday crosses month boundaries', () => {
  assert.equal(resolveDate({ kind: 'weekday', value: 'saturday' }), null);
  assert.equal(resolveDate({ kind: 'yesterday', value: null }, new Date(2026, 2, 1, 12)), '2026-02-28');
});
test('removing a favorite never creates a permanent exclusion and preserves unrelated preferences', () => {
  const { changePreference } = actions();
  const original = { favorite_categories: ['chinese', 'italian'], hard_no_categories: ['thai'],
    budget_level: 2, mostly_solo: true, updated_at: 'synthetic-version' };
  const result = changePreference(original, { type: 'preference_change', operation: 'remove_favorite', category: 'chinese' });
  assert.deepEqual(result.favorites, ['italian']); assert.deepEqual(result.hard_nos, ['thai']);
  assert.equal(result.budget, 2); assert.equal(original.favorite_categories.length, 2);
});
test('chat meal drafts preserve unknown place, time and company without creating a visit', () => {
  const { draftMeal } = actions();
  const draft = draftMeal({ type: 'log_meal', category: 'chicken_wings', date: { kind: 'iso', value: '2026-11-03' },
    slot: null, dish: null, place_name: null, company: [], solo: null, stars: null }, people);
  assert.equal(draft.place_id, null); assert.equal(draft.meal_slot, null);
  assert.deepEqual(draft.companion_ids, []); assert.equal(draft.solo, null); assert.equal(draft.stars, null);
  assert.equal(draft.category_id, 'chicken_wings');
});
test('preparation alone makes no confirmation call and confirmation uses the exact validated payload', async () => {
  const api = actions();
  const action = { key: 'turn:1', kind: 'log_meal', arguments: { category_id: 'chicken_wings' } };
  const prepared = await api.persistPending(action, 'synthetic-conversation');
  assert.deepEqual(api.requests.map((r) => r.path), ['/conversation/actions/prepare']);
  await prepared.save();
  assert.equal(api.requests[1].path, '/conversation/actions/confirm');
  assert.equal(api.requests[1].body.confirmed, true);
  assert.deepEqual(api.requests[1].body.arguments, action.arguments);
});
