import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { emptySurvey, recentContext, searchRequirements, validInterpretation } from './companion.ts';

function syntheticApi(status) {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  const requests = [];
  const dependencies = {
    '@react-native-async-storage/async-storage': {}, './insights': {}, './reasons': {}, './takeaway': {},
    './supabase': { supabase: { auth: { getSession: async () => ({ data: {
      session: { access_token: 'synthetic-token' },
    } }) } } },
  };
  new Function('require', 'module', 'exports', 'process', 'fetch', output)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  }, module, module.exports, { env: { EXPO_PUBLIC_API_URL: 'https://synthetic-api.example' } },
  async (url, options) => {
    requests.push({ url, options });
    return { status, ok: status === 200, json: async () => ({ picks: [] }) };
  });
  return { ...module.exports, requests };
}

test('recommendation transport preserves provider timeout and failure without mislabeling validation errors', async () => {
  for (const [status, code] of [[504, 'places_timeout'], [502, 'places_unavailable'],
    [503, 'places_unavailable'], [422, undefined]]) {
    const api = syntheticApi(status);
    await assert.rejects(api.getRecommendations({}), (error) => error instanceof api.ApiError
      && error.kind === 'server' && error.code === code);
    assert.equal(api.requests.length, 1);
  }
});

test('recommendation transport sends cache invalidation and current survey in the same existing request', async () => {
  const api = syntheticApi(200);
  const state = emptySurvey();
  state.craving = { value: 'japanese_sushi', status: 'confirmed', source: 'typed', turn: 1 };
  await api.getRecommendations({ survey: state, requirements_changed: true });
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].url, 'https://synthetic-api.example/recommendations');
  const sent = JSON.parse(api.requests[0].options.body);
  assert.equal(sent.survey.craving.value, 'japanese_sushi');
  assert.equal(sent.requirements_changed, true);
});

test('cache identity changes for explicit craving changes and clearing, while conversational turns keep it', () => {
  const state = emptySurvey();
  state.craving = { value: 'mexican', status: 'confirmed', source: 'typed', turn: 1 };
  const original = searchRequirements(state);
  state.turn++;
  state.craving.turn++;
  assert.equal(searchRequirements(state), original);
  state.craving.value = 'japanese_sushi';
  assert.notEqual(searchRequirements(state), original);
  const japanese = searchRequirements(state);
  state.craving.value = null;
  assert.notEqual(searchRequirements(state), japanese);
});

test('recent history redacts companions added after the original turn and bounds each line', () => {
  const lines = [{ role: 'user', content: 'Food with Synthetic Jo' },
    { role: 'assistant', content: 'x'.repeat(240) }];
  const safe = recentContext(lines, [{ id: 'synthetic-id', name: 'Synthetic Jo' }]);
  assert.equal(safe[0].content, 'Food with companion_1');
  assert.equal(safe[1].content.length, 200);
  assert.equal(lines[0].content, 'Food with Synthetic Jo');
});

test('mobile rejects malformed conversational replies before rendering them', () => {
  const base = { understood: true, patch: {}, intents: [{ type: 'unknown' }] };
  assert.equal(validInterpretation({ ...base, reply: 'Happy to help you choose!' }), true);
  for (const reply of [42, '', 'x'.repeat(201), 'Hello\nThere', 'Food? Budget?']) {
    assert.equal(validInterpretation({ ...base, reply }), false);
  }
});
