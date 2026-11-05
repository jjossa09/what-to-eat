import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

function api(stall = false) {
  const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} }, timers = [], calls = [];
  const deps = { '@react-native-async-storage/async-storage': {}, './insights': {},
    './reasons': {}, './takeaway': {}, './supabase': { supabase: { auth: {
      getSession: async () => ({ data: { session: { access_token: 'synthetic-token' } } }),
    } } } };
  new Function('require', 'module', 'exports', 'process', 'fetch', 'setTimeout', 'clearTimeout', output)(
    (name) => { assert.ok(Object.hasOwn(deps, name), name); return deps[name]; },
    module, module.exports, { env: { EXPO_PUBLIC_API_URL: 'https://synthetic-api.example' } },
    async (_url, options) => {
      calls.push(options);
      if (stall) await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('synthetic timeout')));
      });
      return { status: 200, ok: true, json: async () => ({ picks: [] }) };
    },
    (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    (timer) => { timer.cleared = true; },
  );
  return { ...module.exports, timers, calls };
}

test('the actual recommendation transport allows 28 seconds, exceeding the whole backend deadline', async () => {
  const backend = readFileSync(new URL('../../api/app/main.py', import.meta.url), 'utf8');
  const deadline = Number(backend.match(/^RECOMMENDATIONS_DEADLINE_S = ([\d.]+)/m)[1]);
  assert.equal(deadline, 24);
  const client = api();
  await client.getRecommendations({ craving: 'pizza', request_source: 'typed' });
  assert.equal(client.RECOMMENDATIONS_TIMEOUT_MS, 28000);
  assert.equal(client.timers[0].ms, 28000);
  assert.ok(client.timers[0].ms > deadline * 1000);
  assert.equal(client.timers[0].cleared, true);
  assert.equal(client.calls.length, 1);
});

test('the recommendation transport aborts at its bounded deadline without an automatic retry', async () => {
  const client = api(true);
  const pending = client.getRecommendations({ craving: 'pizza' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.timers[0].ms, 28000);
  client.timers[0].callback();
  await assert.rejects(pending, (error) => error instanceof client.ApiError && error.kind === 'network');
  assert.equal(client.calls[0].signal.aborted, true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.timers[0].cleared, true);
});
