import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { cacheKey, canonical, loadTakeaway, renderTakeaway, requestTakeaway, sha256 } from './takeaway.ts';
import { withInsightsDeadline } from './insights.ts';

const DATE = '2026-11-04';
const A = 'aaaaaaaa-1111-4111-8111-000000000001';
const USER = 'synthetic-user';
const STATS = { complete: true, cutoff_date: DATE, summary: { meal_count: 26 },
  top_categories: [{ category_id: 'chinese', meal_count: 8 }],
  distance_by_slot: [{ meal_slot: 'dinner', points: [{ eaten_on: DATE, distance_m: 1000 }] }] };
const ACCEPTED = { source: 'muse', line: 'You recorded 5 meals with Companion 1.',
  companion_refs: [{ placeholder: 'Companion 1', companion_id: A }] };

function fixture(overrides = {}) {
  const data = new Map();
  let requests = 0, writes = 0;
  const options = { user: USER, date: DATE, stats: STATS, saved: [{ id: A, name: 'Alex' }],
    storage: {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => { writes++; data.set(key, value); },
    },
    request: async () => { requests++; return ACCEPTED; }, ...overrides };
  return { options, data, requests: () => requests, writes: () => writes };
}

test('SHA-256 matches Node for empty, ASCII, Unicode, and multi-block JSON', () => {
  for (const text of ['', 'abc', 'Compañía 🍜', canonical(STATS), 'x'.repeat(1000)]) {
    assert.equal(sha256(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('cache identity hashes the entire existing response, date, and authenticated user', () => {
  const key = cacheKey(USER, DATE, STATS);
  assert.equal(key, cacheKey(USER, DATE, { ...STATS, summary: { meal_count: 26 } }));
  assert.equal(key, cacheKey(USER, DATE, Object.fromEntries(Object.entries(STATS).reverse())));
  assert.notEqual(key, cacheKey('other-user', DATE, STATS));
  assert.notEqual(key, cacheKey(USER, '2026-11-05', STATS));
  const changed = structuredClone(STATS);
  changed.distance_by_slot[0].points[0].distance_m = 1001;
  assert.notEqual(key, cacheKey(USER, DATE, changed));
  assert.ok(!key.includes(USER) && !key.includes(DATE) && !key.includes('chinese'));
});

test('accepted anonymous line is cached and identical date and facts make no request', async () => {
  const f = fixture();
  assert.deepEqual(await loadTakeaway(f.options), {
    source: 'muse', line: 'You recorded 5 meals with Alex.', cached: false,
  });
  assert.deepEqual(await loadTakeaway(f.options), {
    source: 'muse', line: 'You recorded 5 meals with Alex.', cached: true,
  });
  assert.equal(f.requests(), 1);
  assert.equal(f.writes(), 1);
  const value = [...f.data.values()][0];
  assert.ok(value.includes('Companion 1') && !value.includes('Alex'));
});

test('cached placeholders use current saved names and literal replacement', async () => {
  const f = fixture();
  await loadTakeaway(f.options);
  const reply = await loadTakeaway({ ...f.options, saved: [{ id: A, name: 'Sam $&' }] });
  assert.equal(reply.line, 'You recorded 5 meals with Sam $&.');
  assert.equal(f.requests(), 1);
});

test('a missing name hides the personalized line without inventing a replacement', async () => {
  const f = fixture({ saved: [] });
  assert.equal((await loadTakeaway(f.options)).line, null);
  assert.equal((await loadTakeaway(f.options)).line, null);
  assert.equal(f.requests(), 1);
  assert.equal(renderTakeaway(ACCEPTED, [{ id: A, name: '' }]), null);
  assert.equal(renderTakeaway({ ...ACCEPTED, companion_refs: [] }, [{ id: A, name: 'Alex' }]), null);
});

test('substituted names keep one short line and do not expose broken placeholders', () => {
  for (const name of ['x'.repeat(90), 'Alex\nSam', 'Alex — Sam']) {
    assert.equal(renderTakeaway(ACCEPTED, [{ id: A, name }]), null);
  }
  assert.equal(renderTakeaway({ source: 'muse', line: 'Chinese appears in 8 meals.',
    companion_refs: [] }, []), 'Chinese appears in 8 meals.');
});

test('a failed request is hidden and never cached, so the next opening can retry', async () => {
  const f = fixture();
  let attempts = 0;
  const options = { ...f.options, request: async () => {
    attempts++;
    if (attempts === 1) throw new Error('503');
    return ACCEPTED;
  } };
  assert.deepEqual(await loadTakeaway(options), { source: 'none', line: null, cached: false });
  assert.equal(f.data.size, 0);
  assert.equal((await loadTakeaway(options)).line, 'You recorded 5 meals with Alex.');
  assert.equal(attempts, 2);
});

test('template, none, and malformed responses are never cached', async () => {
  for (const reply of [
    { source: 'template', line: 'Chinese appears in 8 recorded meals.', companion_refs: [] },
    { source: 'none', line: null, companion_refs: [] },
    { source: 'muse', line: 'x'.repeat(91), companion_refs: [] },
    { source: 'muse', line: 'Chinese\n8 meals.', companion_refs: [] }, null,
  ]) {
    let requests = 0;
    const f = fixture({ request: async () => { requests++; return reply; } });
    await loadTakeaway(f.options);
    await loadTakeaway(f.options);
    assert.equal(requests, 2);
    assert.equal(f.data.size, 0);
  }
});

test('storage failures and corrupt cache never prevent a fresh accepted line', async () => {
  const f = fixture({ storage: {
    getItem: async () => { throw new Error('storage read'); },
    setItem: async () => { throw new Error('storage write'); },
  } });
  assert.equal((await loadTakeaway(f.options)).line, 'You recorded 5 meals with Alex.');
  const corrupted = fixture();
  corrupted.data.set(cacheKey(USER, DATE, STATS), '{bad');
  assert.equal((await loadTakeaway(corrupted.options)).source, 'muse');
  assert.equal(corrupted.requests(), 1);
});

test('takeaway deadline includes response-body reading and hides timeout without caching', async () => {
  const f = fixture();
  let aborted = false;
  const options = { ...f.options, request: () => withInsightsDeadline(async (signal) => {
    signal.addEventListener('abort', () => { aborted = true; });
    const response = { json: () => new Promise(() => {}) };
    return await response.json();
  }, 10) };
  assert.deepEqual(await loadTakeaway(options), { source: 'none', line: null, cached: false });
  assert.equal(aborted, true);
  assert.equal(f.data.size, 0);
});

test('a new day, user, or response causes a fresh request', async () => {
  const f = fixture();
  await loadTakeaway(f.options);
  await loadTakeaway({ ...f.options, date: '2026-11-05' });
  await loadTakeaway({ ...f.options, user: 'other-user' });
  await loadTakeaway({ ...f.options, stats: { ...STATS, complete: false } });
  assert.equal(f.requests(), 4);
});

test('the takeaway POST uploads only as_of and a 503 is not cached', async () => {
  let requests = 0;
  const signal = new AbortController().signal;
  const send = async (url, options) => {
    requests++;
    assert.equal(url, 'https://synthetic.invalid/insights/takeaway');
    assert.equal(options.method, 'POST');
    assert.equal(options.signal, signal);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    assert.deepEqual(JSON.parse(options.body), { as_of: DATE });
    return { ok: false, status: 503 };
  };
  const f = fixture({ request: () => requestTakeaway('https://synthetic.invalid/insights/takeaway',
    'synthetic-token', DATE, signal, send) });
  assert.equal((await loadTakeaway(f.options)).line, null);
  assert.equal((await loadTakeaway(f.options)).line, null);
  assert.equal(requests, 2);
  assert.equal(f.data.size, 0);
});

test('a late response body after the phone timeout cannot populate the cache', async () => {
  let finishBody;
  const send = async () => ({ ok: true, json: () => new Promise((resolve) => { finishBody = resolve; }) });
  const f = fixture();
  let pending;
  await assert.rejects(withInsightsDeadline((signal) => {
    pending = loadTakeaway({ ...f.options, request: () => requestTakeaway(
      'https://synthetic.invalid/insights/takeaway', 'synthetic-token', DATE, signal, send) });
    return pending;
  }, 10), /timeout/);
  finishBody(ACCEPTED);
  assert.deepEqual(await pending, { source: 'none', line: null, cached: false });
  assert.equal(f.data.size, 0);
});
