import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { parseFailureLine } from './companion.ts';

function api() {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} }, deadlines = [], requests = [];
  const deps = {
    '@react-native-async-storage/async-storage': {}, './takeaway': {},
    './insights': { withInsightsDeadline: async (work, ms) => {
      deadlines.push(ms); return work(new AbortController().signal);
    } },
    './reasons': { languageRequest: async (_url, _body, _auth, _deadline, ms) => {
      deadlines.push(ms); return {};
    } },
    './supabase': { supabase: { auth: { getSession: async () => ({ data: {
      session: { access_token: 'synthetic-token' },
    } }) } } },
  };
  new Function('require', 'module', 'exports', 'process', 'fetch', output)((name) => {
    assert.ok(Object.hasOwn(deps, name), name); return deps[name];
  }, module, module.exports, { env: { EXPO_PUBLIC_API_URL: 'https://synthetic-api.example' } },
  async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; });
  return { ...module.exports, deadlines, requests };
}

test('companion parse gets a bounded 20-second deadline while legacy parsing and reasons keep their limits', async () => {
  const client = api();
  await client.companionCall('/conversation/parse', { text: 'synthetic' });
  await client.companionCall('/conversation/parse', { text: 'synthetic' }, 999999);
  await client.companionCall('/conversation/parse', { text: 'synthetic' }, 5000);
  await client.companionCall('/conversation/plan', {});
  await client.parseAnswer('craving', 'synthetic');
  await client.getReasons({ payload: 'synthetic', signature: 'synthetic' });
  assert.deepEqual(client.deadlines, [20000, 20000, 5000, 16000, 16000, 18000]);
  assert.equal(client.requests.length, 4);
});

test('rate limits, exhausted credits, daily cap and timeout have distinct truthful fallbacks', () => {
  const statuses = ['rate_limited', 'quota_exhausted', 'daily_limit', 'timeout', 'truncated', 'unavailable'];
  const lines = statuses.map((status) => parseFailureLine({ status }));
  assert.equal(new Set(lines).size, statuses.length);
  assert.ok(lines[0].includes('busy'));
  assert.ok(lines[1].includes('credits'));
  assert.ok(lines[2].includes('daily limit'));
});
