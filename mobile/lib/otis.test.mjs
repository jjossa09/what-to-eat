import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OtisController } from './otis.ts';
import { ReasonsCache, swapReason } from './reasons.ts';

const IDS = ['node/101', 'node/102', 'node/103'];
const ROUND = { userId: 'synthetic-user', sessionId: 'synthetic-session', round: 1, generation: 0 };
const RESULT = { source: 'muse', reasons: IDS.map((id) => ({ id, line: 'A nearby option.' })) };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(ids = IDS) {
  const timers = [];
  const controller = new OtisController(1200, (callback, ms) => {
    const timer = { callback, ms, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  controller.setActive(true);
  const token = controller.begin();
  const observer = controller.observeReasons(token, ROUND, ids);
  const state = () => controller.getSnapshot().state;
  return { controller, token, observer, timers, state };
}

test('template cards and accepted reasons keep Otis thinking until every current line finishes', () => {
  const h = fixture();
  assert.equal(h.state(), 'thinking');
  h.observer.displayed(IDS[0]); // Not accepted yet.
  h.observer.accepted();
  assert.equal(h.state(), 'thinking');
  h.observer.displayed(IDS[1]);
  h.observer.displayed(IDS[1]);
  h.observer.displayed('node/999');
  h.observer.displayed(IDS[2]);
  assert.equal(h.state(), 'thinking');
  assert.equal(h.timers.length, 0);
  h.observer.displayed(IDS[0]);
  assert.equal(h.state(), 'happy');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 1200);
  h.observer.accepted();
  h.observer.displayed(IDS[0]);
  h.observer.fallback();
  assert.equal(h.state(), 'happy');
  assert.equal(h.timers.length, 1);
  h.timers[0].callback();
  assert.equal(h.state(), 'idle');
});

test('completion uses the actual number of picks and empty rounds never celebrate', () => {
  for (const ids of [IDS.slice(0, 1), IDS.slice(0, 2), []]) {
    const h = fixture(ids);
    h.observer.accepted();
    ids.forEach(h.observer.displayed);
    assert.equal(h.state(), ids.length ? 'happy' : 'idle');
    assert.equal(h.timers.length, ids.length ? 1 : 0);
  }
});

test('parsing completion, fallback and duplicate fallback settle without celebration', () => {
  const h = fixture();
  h.observer.fallback();
  h.observer.fallback();
  h.observer.accepted();
  IDS.forEach(h.observer.displayed);
  assert.equal(h.state(), 'idle');
  assert.equal(h.timers.length, 0);
  const parsing = h.controller.begin();
  assert.equal(h.state(), 'thinking');
  h.controller.finish(parsing);
  assert.equal(h.state(), 'idle');
});

test('new operations invalidate old observers even when the round identity is unchanged', () => {
  const h = fixture();
  h.observer.accepted();
  const next = h.controller.begin();
  const observer = h.controller.observeReasons(next, ROUND, IDS);
  assert.equal(h.observer.current(), false);
  IDS.forEach(h.observer.displayed);
  h.observer.fallback();
  h.controller.finish(h.token);
  assert.equal(h.state(), 'thinking');
  observer.accepted();
  IDS.forEach(observer.displayed);
  assert.equal(h.state(), 'happy');
});

test('a mismatched round observer cannot settle or display the current operation', () => {
  const h = fixture();
  const wrong = h.controller.observeReasons(h.token, { ...ROUND, round: 2 }, IDS);
  wrong.accepted();
  IDS.forEach(wrong.displayed);
  wrong.fallback();
  assert.equal(wrong.current(), false);
  assert.equal(h.state(), 'thinking');
  h.observer.fallback();
  assert.equal(h.state(), 'idle');
});

test('cancellation rejects stale responses, display callbacks and even a fired cancelled timer', () => {
  const h = fixture();
  h.observer.accepted();
  IDS.forEach(h.observer.displayed);
  h.controller.cancel();
  assert.equal(h.timers[0].cancelled, true);
  const token = h.controller.begin();
  h.observer.accepted();
  h.observer.displayed(IDS[0]);
  h.observer.fallback();
  h.timers[0].callback();
  assert.equal(h.state(), 'thinking');
  h.controller.finish(token);
  assert.equal(h.state(), 'idle');
});

test('hidden acceptance or display completion never produces a delayed celebration', () => {
  for (const hideBeforeAcceptance of [true, false]) {
    const h = fixture();
    if (!hideBeforeAcceptance) h.observer.accepted();
    h.controller.setActive(false);
    if (hideBeforeAcceptance) h.observer.accepted();
    // Even returning before the remaining line callbacks must not replay this success.
    h.controller.setActive(true);
    IDS.forEach(h.observer.displayed);
    assert.equal(h.state(), 'idle');
    assert.equal(h.timers.length, 0);
  }
});

test('pending work resumes normally when Eat returns before enhancement acceptance', () => {
  const h = fixture();
  h.controller.setActive(false);
  assert.equal(h.state(), 'thinking');
  h.controller.setActive(true);
  h.observer.accepted();
  IDS.forEach(h.observer.displayed);
  assert.equal(h.state(), 'happy');
});

test('hiding during happy clears its timer and foregrounding does not replay it', () => {
  const h = fixture();
  h.observer.accepted();
  IDS.forEach(h.observer.displayed);
  h.controller.setActive(false);
  assert.equal(h.state(), 'idle');
  assert.equal(h.timers[0].cancelled, true);
  h.controller.setActive(true);
  h.timers[0].callback();
  assert.equal(h.state(), 'idle');
});

test('controller subscriptions emit only snapshot changes and unsubscribe cleanly', () => {
  const h = fixture();
  const seen = [];
  const stop = h.controller.subscribe(() => seen.push(h.controller.getSnapshot()));
  h.controller.setActive(true);
  h.controller.begin(); // Still thinking; no intermediate idle publication.
  assert.equal(seen.length, 0);
  h.controller.cancel();
  assert.deepEqual(seen, [{ state: 'idle', active: true }]);
  stop();
  h.controller.begin();
  h.controller.cancel();
  assert.equal(seen.length, 1);
});

test('synchronous cancellation during celebration clears the already-owned happy timer', () => {
  const h = fixture();
  h.controller.subscribe(() => { if (h.state() === 'happy') h.controller.cancel(); });
  h.observer.accepted();
  IDS.forEach(h.observer.displayed);
  assert.equal(h.state(), 'idle');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].cancelled, true);
  h.timers[0].callback();
  assert.equal(h.state(), 'idle');
});

test('cache hits and simultaneous watchers share one request and celebrate only once', async () => {
  const h = fixture();
  const cache = new ReasonsCache();
  let calls = 0;
  const request = async () => { calls++; return RESULT; };
  const watch = () => cache.watch('synthetic-session:1', IDS, cache.current(), request,
    () => h.observer.accepted(), h.observer.fallback);
  watch();
  watch();
  await tick();
  IDS.forEach(h.observer.displayed);
  watch();
  await tick();
  IDS.forEach(h.observer.displayed);
  assert.equal(calls, 1);
  assert.equal(h.timers.length, 1);
  assert.equal(h.state(), 'happy');
});

test('failed, template, malformed and timed-out enhancements settle idle and never retry', async () => {
  for (const request of [
    async () => { throw new Error('timeout'); },
    async () => ({ source: 'template', reasons: [] }),
    async () => ({ ...RESULT, reasons: RESULT.reasons.slice(1) }),
    async () => ({ ...RESULT, reasons: RESULT.reasons.map((reason) => ({ ...reason, line: '' })) }),
  ]) {
    const h = fixture();
    const cache = new ReasonsCache();
    let calls = 0;
    const watch = () => cache.watch('synthetic-session:1', IDS, cache.current(),
      () => { calls++; return request(); }, () => assert.fail('Invalid enhancement was accepted'), h.observer.fallback);
    watch();
    await tick();
    watch();
    await tick();
    assert.equal(h.state(), 'idle');
    assert.equal(calls, 1);
    assert.equal(h.timers.length, 0);
  }
});

test('late fallback notification is suppressed on watcher cleanup and cache invalidation', async () => {
  for (const invalidate of [false, true]) {
    const cache = new ReasonsCache();
    const pending = deferred();
    let settled = 0;
    const stop = cache.watch('synthetic-session:1', IDS, cache.current(), () => pending.promise,
      () => { settled++; }, () => { settled++; });
    if (invalidate) cache.invalidate();
    else stop();
    pending.resolve({ source: 'template', reasons: [] });
    await tick();
    assert.equal(settled, 0);
  }
});

test('reason completion waits for both fades and rejects a stale final callback', () => {
  for (const stale of [false, true]) {
    const steps = [];
    let current = true, applied = 0, displayed = 0;
    swapReason(false, () => current, () => { applied++; }, (opacity, ms, done) => {
      steps.push({ opacity, ms, done });
      return () => {};
    }, () => { displayed++; });
    assert.equal(displayed, 0);
    steps[0].done();
    assert.equal(applied, 1);
    assert.equal(displayed, 0);
    assert.deepEqual(steps.map(({ opacity, ms }) => [opacity, ms]), [[0, 90], [1, 90]]);
    if (stale) current = false;
    steps[1].done();
    assert.equal(displayed, stale ? 0 : 1);
  }
});

test('Reduce Motion completes immediately without a fade and cancellation rejects old callbacks', () => {
  let applied = 0, displayed = 0, oldDone;
  const stop = swapReason(false, () => true, () => { applied++; }, (_, __, done) => {
    oldDone = done;
    return () => {};
  }, () => { displayed++; });
  stop();
  swapReason(true, () => true, () => { applied++; }, () => assert.fail('Must stay still'), () => { displayed++; });
  oldDone();
  assert.equal(applied, 1);
  assert.equal(displayed, 1);
});
