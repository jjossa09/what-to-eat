import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withInsightsDeadline } from './insights.ts';
import { languageRequest, ReasonsCache, swapReason } from './reasons.ts';

const IDS = ['node/1', 'node/2', 'node/3'];
const RESULT = { source: 'muse', reasons: IDS.map((id) => ({ id, line: 'A nearby spot.' })) };
const KEY = 'synthetic-user:synthetic-session:1';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('cache hit makes no second request and simultaneous readers share one request', async () => {
  const cache = new ReasonsCache();
  let calls = 0;
  const pending = deferred();
  const request = () => { calls++; return pending.promise; };
  const first = cache.load(KEY, IDS, request);
  assert.equal(first, cache.load(KEY, IDS, request));
  await tick();
  assert.equal(calls, 1);
  pending.resolve(RESULT);
  assert.deepEqual(await first, RESULT);
  assert.deepEqual(await cache.load(KEY, IDS, request), RESULT);
  assert.equal(calls, 1);
});

test('failures stay attempted and never retry automatically', async () => {
  const cache = new ReasonsCache();
  let calls = 0;
  const request = async () => { calls++; throw new Error('Unavailable'); };
  assert.equal(await cache.load(KEY, IDS, request), null);
  assert.equal(await cache.load(KEY, IDS, request), null);
  assert.equal(calls, 1);
});

test('different users sessions and rounds do not reuse a cached result', async () => {
  const cache = new ReasonsCache();
  let calls = 0;
  for (const key of [KEY, 'other-user:synthetic-session:1',
    'synthetic-user:other-session:1', 'synthetic-user:synthetic-session:2']) {
    await cache.load(key, IDS, async () => { calls++; return RESULT; });
  }
  assert.equal(calls, 4);
});

for (const transition of ['refinement', 'pick', 'new search', 'unmount']) {
  test(`late result after ${transition} is ignored`, async () => {
    const cache = new ReasonsCache();
    const pending = deferred();
    const applied = [];
    const stop = cache.watch(KEY, IDS, cache.current(), () => pending.promise,
      (result) => applied.push(result));
    await tick();
    if (transition === 'unmount') stop();
    else cache.invalidate();
    pending.resolve(RESULT);
    await tick();
    assert.deepEqual(applied, []);
  });
}

test('active result is applied once and unmounted watchers do not block another watcher', async () => {
  const cache = new ReasonsCache();
  const pending = deferred();
  const applied = [];
  const stop = cache.watch(KEY, IDS, cache.current(), () => pending.promise,
    () => applied.push('unmounted'));
  stop();
  cache.watch(KEY, IDS, cache.current(), () => { throw new Error('duplicate'); },
    () => applied.push('active'));
  pending.resolve(RESULT);
  await tick();
  assert.deepEqual(applied, ['active']);
});

test('clearing chat cache invalidates old results and permits a fresh chat request', async () => {
  const cache = new ReasonsCache();
  const generation = cache.current();
  let calls = 0;
  const request = async () => { calls++; return RESULT; };
  await cache.load(KEY, IDS, request);
  cache.clear();
  assert.equal(cache.isCurrent(generation), false);
  await cache.load(KEY, IDS, request);
  assert.equal(calls, 2);
});

test('wrong duplicate missing IDs and malformed reason lines leave templates intact', async () => {
  for (const result of [null, {}, { source: 'template', reasons: [] },
    { ...RESULT, reasons: RESULT.reasons.slice(1) },
    { ...RESULT, reasons: [RESULT.reasons[0], RESULT.reasons[0], RESULT.reasons[2]] },
    ...['', 'x'.repeat(91), 'two\nlines', null].map((line) => ({ ...RESULT,
      reasons: [{ id: IDS[0], line }, ...RESULT.reasons.slice(1)] })),
    { ...RESULT, reasons: [{ id: 'wrong', line: 'Fine.' }, ...RESULT.reasons.slice(1)] }]) {
    assert.equal(await new ReasonsCache().load(KEY, IDS, async () => result), null);
  }
});

test('normal reason swap fades out and in for 180 ms total', () => {
  const steps = [];
  let applied = false;
  const fade = (opacity, duration, done) => {
    steps.push({ opacity, duration, done });
    return () => {};
  };
  swapReason(false, () => true, () => { applied = true; }, fade);
  assert.equal(applied, false);
  assert.deepEqual(steps.map(({ opacity, duration }) => [opacity, duration]), [[0, 90]]);
  steps[0].done();
  assert.equal(applied, true);
  assert.deepEqual(steps.map(({ opacity, duration }) => [opacity, duration]), [[0, 90], [1, 90]]);
});

test('Reduce Motion applies immediately with no animation', () => {
  let applied = 0;
  swapReason(true, () => true, () => { applied++; }, () => assert.fail('Must not animate'));
  assert.equal(applied, 1);
});

test('Reduce Motion change cancels the old fade before applying immediately', () => {
  let callback, stopped = 0, applied = 0;
  const cancel = swapReason(false, () => true, () => { applied++; }, (_, __, done) => {
    callback = done;
    return () => { stopped++; };
  });
  cancel();
  swapReason(true, () => true, () => { applied++; }, () => assert.fail('Must not animate'));
  callback();
  assert.equal(stopped, 1);
  assert.equal(applied, 1);
});

test('stale animation callback never replaces the template and restores opacity', () => {
  let current = true, applied = false;
  const steps = [];
  swapReason(false, () => current, () => { applied = true; }, (opacity, duration, done) => {
    steps.push({ opacity, duration, done });
    return () => {};
  });
  current = false;
  steps[0].done();
  assert.equal(applied, false);
  assert.equal(steps.at(-1).opacity, 1);
});

test('language request deadline includes stalled authentication without starting fetch', async () => {
  let sent = false;
  await assert.rejects(languageRequest('https://synthetic.invalid/reasons', {},
    () => new Promise(() => {}), withInsightsDeadline, 10,
    async () => { sent = true; }), /timeout/);
  assert.equal(sent, false);
});

test('language request deadline includes body reading even when transport ignores abort', async () => {
  let signal;
  await assert.rejects(languageRequest('https://synthetic.invalid/reasons', {},
    async () => 'synthetic-token', withInsightsDeadline, 10,
    async (_, options) => {
      signal = options.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    }), /timeout/);
  assert.equal(signal.aborted, true);
});

test('language request carries the envelope unchanged and never retries a 429', async () => {
  const body = { payload: '{"picks":[]}', signature: 'synthetic' };
  let calls = 0;
  await assert.rejects(languageRequest('https://synthetic.invalid/reasons', body,
    async () => 'synthetic-token', withInsightsDeadline, 100,
    async (_, options) => {
      calls++;
      assert.equal(options.body, JSON.stringify(body));
      return { ok: false, status: 429 };
    }));
  assert.equal(calls, 1);
});
