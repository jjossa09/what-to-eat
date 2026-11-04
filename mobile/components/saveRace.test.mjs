import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { OtisController } from '../lib/otis.ts';
import { ReasonsCache } from '../lib/reasons.ts';
import * as questionPlan from '../lib/questionPlan.ts';

// Execute production handlers and effects. Native layout, spring physics and tactile strength
// are intentionally left to iPhone verification. Timers and requests settle explicitly.
function load(file, imports = {}, globals = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const dependencies = { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, ...imports };
  new Function('require', 'module', 'exports', ...Object.keys(globals), outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unstubbed import: ${name}`);
    return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
const theme = load('../theme.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function hooks() {
  const slots = [];
  let cursor = 0, dirty = false, effects = [], tree, updates = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; updates++; }
      }];
    },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0]; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !equal(slots[index].deps, deps)) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { deps, cleanup };
        effects.push(() => { cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, fn };
      return slots[index].fn;
    },
    useId: () => 'synthetic-chart',
    useSyncExternalStore(subscribe, getSnapshot) {
      const [, notify] = react.useState(getSnapshot);
      react.useEffect(() => {
        const stop = subscribe(() => notify(getSnapshot()));
        notify(getSnapshot());
        return stop;
      }, [subscribe, getSnapshot]);
      return getSnapshot();
    },
  };
  return { react, get updates() { return updates; }, flush(Component, props = {}) {
    for (let attempt = 0; attempt < 20; attempt++) {
      cursor = 0; dirty = false; effects = []; tree = Component(props);
      const pending = effects; effects = []; pending.forEach((effect) => effect());
      if (!dirty) return tree;
    }
    assert.fail('Render did not settle');
  }, unmount() { slots.forEach((slot) => slot?.cleanup?.()); } };
}
function native() {
  const animations = [], listeners = new Set();
  class Value {
    constructor(value) { this.value = value; this.stops = 0; }
    setValue(value) { this.value = value; }
    stopAnimation() { this.stops++; }
    interpolate(config) { return { value: this, config }; }
  }
  const animate = (value, config) => ({ value, config,
    start(done) { this.done = done; animations.push(this); }, stop() { this.stopped = true; },
  });
  const AppState = { currentState: 'active', addEventListener(_, fn) {
    listeners.add(fn); return { remove: () => listeners.delete(fn) };
  } };
  return { animations, listeners, change(state) { AppState.currentState = state; listeners.forEach((fn) => fn(state)); },
    module: { ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'Modal', 'ScrollView',
      'KeyboardAvoidingView', 'ActivityIndicator'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 }, AppState,
    Animated: { Value, View: 'AnimatedView', Text: 'AnimatedText', createAnimatedComponent: (c) => `Animated${c}`,
      spring: animate, timing: animate, add: (...values) => values,
      parallel: () => ({ start() {}, stop() {} }) },
    Keyboard: { dismiss() {}, addListener: () => ({ remove() {} }) },
    PanResponder: { create: (handlers) => ({ panHandlers: handlers }) },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Linking: { openURL() {} },
  } };
}
function nodes(element, type) {
  if (!element || typeof element !== 'object') return [];
  return [...(element.type === type ? [element] : []),
    ...[element.props?.children].flat(Infinity).flatMap((child) => nodes(child, type))];
}
const find = (tree, type, label) => {
  const node = nodes(tree, type).find((node) => node.props.label === label || node.props.accessibilityLabel === label);
  assert.ok(node, `Missing ${type} ${label}`); return node;
};
const hosts = { Chip: 'Chip', GlassCard: 'GlassCard', GlassScreen: 'GlassScreen', PrimaryButton: 'PrimaryButton',
  SecondaryButton: 'SecondaryButton', TextLink: 'TextLink', Dots: 'Dots' };

class ApiError extends Error { constructor(kind) { super(kind); this.kind = kind; } }
const pick = { id: 'synthetic-place', name: 'Synthetic Cafe', category: 'pizza', reason: 'Close by.',
  distance_m: 200, lat: 1, lon: 2 };
const parsed = { status: 'ok', answer: { craving: 'pizza', budget_level: null, radius_m: null,
  exclude_categories: [] } };
const result = (round, final = false) => ({ session_id: 'synthetic-session', round, logged: true,
  picks: [{ ...pick, id: `synthetic-place-${round}` }],
  answers: { craving: 'pizza', budget_level: 1, radius_m: 15000, exclude_categories: [] },
  reasons_envelope: null, best_so_far: final, next_question: null });

async function fixture({ final = false } = {}) {
  const h = hooks(), rn = native(), saves = [], requests = [], parses = [], reminders = [], feedback = [];
  const save = (kind, args) => {
    const pending = deferred(); saves.push({ kind, args, ...pending }); return pending.promise;
  };
  const api = { ApiError,
    getQuestionPlan: async () => ({ questions: ['craving', 'budget', 'distance']
      .map((key) => ({ key, prefill: null })) }),
    getRecommendations: (body) => {
      const pending = deferred(); requests.push({ body, ...pending }); return pending.promise;
    },
    parseAnswer: (key, text) => {
      const pending = deferred(); parses.push({ key, text, ...pending }); return pending.promise;
    },
    logPicked: (...args) => save('picked', args), logNone: (...args) => save('none', args),
    logInterested: async () => {},
    localTimeIso: () => '2026-11-03T12:00:00-05:00', deviceTimezone: () => 'America/New_York',
  };
  class Controller extends OtisController { constructor(ms) { super(ms, () => () => {}); } }
  const navigation = { isFocused: () => true };
  const Chat = load('./Chat.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '@react-navigation/native': { useNavigation: () => navigation,
      useFocusEffect: (effect) => h.react.useEffect(effect, [effect]) },
    '../lib/api': api, '../lib/location': {
      getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }),
    },
    '../lib/profile': { loadTastePrior: async () => ({ favorites: ['pizza'], budget: 2, mostlySolo: true }),
      loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }], loadDisplayName: async () => null,
      loadCompanionChoices: async () => [] },
    '../lib/notify': { remindAfterPick: (id) => reminders.push(id) },
    '../lib/haptics': { haptic: (kind) => feedback.push(kind) },
    '../lib/questionPlan': questionPlan, '../lib/otis': { OtisController: Controller },
    '../lib/reasons': { ReasonsCache }, './Composer': 'Composer', './Otis': 'Otis', './ResultCards': 'ResultCards',
    './ScrollWithBar': 'ScrollWithBar', './TypingBubble': 'TypingBubble', './ui': hosts,
  }, { __DEV__: false }).default;
  const props = { userId: 'synthetic-user', bottom: 108, onSignOut() {} };
  const cards = new Map();
  const render = () => h.flush(Chat, props);
  const card = (index = 0) => {
    const props = nodes(render(), 'ResultCards')[index].props;
    if (!cards.has(index)) {
      const c = hooks();
      const Component = load('./ResultCards.tsx', { react: c.react, 'react-native': rn.module, '../theme': theme,
        '../lib/accessibility': {}, '../lib/haptics': { haptic: (kind) => feedback.push(kind) },
        '../lib/api': api, '../lib/places': { directionsUrl: () => 'https://maps.apple.com/' },
        '../lib/reasons': {}, './PlaceMap': { MiniMap: 'MiniMap', Attribution: 'Attribution' },
        './PressScale': 'PressScale', './ui': hosts,
      }).default;
      cards.set(index, { h: c, Component });
    }
    const c = cards.get(index);
    return c.h.flush(c.Component, props);
  };
  render(); await tick();
  for (const label of ['Pizza', '$', 'Close to me']) find(render(), 'Chip', label).props.onPress();
  await tick(); requests[0].resolve(result(1, final)); await tick(); card(); feedback.length = 0;
  const send = (text = 'Synthetic refinement') => nodes(render(), 'Composer')[0].props.onSend(text);
  const begin = (index = 0, label = 'Pick this') => find(card(index), 'Chip', label).props.onPress();
  const lines = () => nodes(render(), 'Text').flatMap((node) =>
    typeof node.props.children === 'string' ? [node.props.children] : []);
  const refine = async () => {
    send(); parses.at(-1).resolve(parsed); await tick();
    requests.at(-1).resolve(result(requests.length)); await tick(); card(0);
  };
  return { h, rn, saves, requests, parses, reminders, feedback, render, card, begin, send, lines, refine,
    dispose() { cards.forEach((c) => c.h.unmount()); h.unmount(); } };
}

test('current save succeeds once, reports its place and preserves the feedback reminder', async () => {
  const f = await fixture(); const button = find(f.card(), 'Chip', 'Pick this');
  button.props.onPress(); button.props.onPress();
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0].args, ['synthetic-session', 1, 'synthetic-place-1']);
  f.saves[0].resolve({ logged: true }); await tick();
  assert.equal(f.lines().filter((line) => line === 'Enjoy Synthetic Cafe!').length, 1);
  assert.deepEqual(f.reminders, ['synthetic-user']); assert.deepEqual(f.feedback, ['success']);
  assert.equal(find(f.card(), 'Chip', 'Directions').props.label, 'Directions');
  assert.equal(nodes(f.card(), 'Chip').some((node) => node.props.label === 'Pick this'), false);
  f.dispose();
});

test('verified HTTP 200 retry confirms the original operation once after a lost response', async () => {
  const f = await fixture(); f.begin();
  f.saves[0].reject(new ApiError('network')); await tick();
  const retry = find(f.card(), 'Chip', 'Try again'); retry.props.onPress(); retry.props.onPress();
  assert.equal(f.saves.length, 2);
  assert.deepEqual(f.saves[1].args, f.saves[0].args);
  f.saves[1].resolve({ logged: true, meal_id: 'synthetic-original-meal' }); await tick();
  assert.deepEqual(f.feedback, ['success']); assert.deepEqual(f.reminders, ['synthetic-user']);
  assert.equal(f.lines().filter((line) => line === 'Enjoy Synthetic Cafe!').length, 1);
  assert.equal(nodes(f.card(), 'Chip').some((node) => node.props.label === 'Try again'), false);
  f.dispose();
});

test('genuine 409 closes only the original search without a saved claim, celebration or reminder', async () => {
  const f = await fixture(); const button = find(f.card(), 'Chip', 'Pick this');
  button.props.onPress(); button.props.onPress(); assert.equal(f.saves.length, 1);
  f.saves[0].reject(new ApiError('conflict')); await tick();
  assert.ok(nodes(f.card(), 'Text').some((node) => node.props.children === 'Search already decided.'));
  assert.equal(f.lines().includes('Already saved.'), false);
  assert.equal(f.lines().includes('Enjoy Synthetic Cafe!'), false);
  assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, []);
  assert.equal(nodes(f.card(), 'Chip').some((node) => ['Pick this', 'Try again'].includes(node.props.label)), false);
  f.send('Synthetic new search'); assert.equal(f.parses.at(-1).key, 'craving'); f.dispose();
});

for (const phase of ['parsing', 'fetching', 'results']) {
  test(`delayed pick success during ${phase} cannot decide or message the newer conversation`, async () => {
    const f = await fixture(); f.begin(); f.send();
    if (phase !== 'parsing') { f.parses[0].resolve(parsed); await tick(); }
    if (phase === 'results') { f.requests[1].resolve(result(2)); await tick(); }
    f.card(); // The original card remains mounted, including while still the latest round.
    f.feedback.length = 0;
    f.saves[0].resolve({ logged: true }); await tick();
    assert.equal(f.lines().includes('Enjoy Synthetic Cafe!'), false);
    assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, ['synthetic-user']);
    assert.equal(f.saves.length, 1);
    // A subsequent typed answer must still refine, not start a new craving search.
    if (phase === 'parsing') { f.parses[0].resolve(parsed); await tick(); }
    if (phase !== 'results') { f.requests[1].resolve(result(2)); await tick(); }
    f.send('Synthetic next refinement');
    assert.equal(f.parses.at(-1).key, 'refine');
    f.dispose();
  });
}

for (const response of ['not_sure', 'network']) {
  test(`a ${response} refinement does not restore an older save's conversation ownership`, async () => {
    const f = await fixture(); f.begin(); f.send();
    f.saves[0].resolve({ logged: true }); await tick();
    if (response === 'network') f.parses[0].reject(new ApiError('network'));
    else f.parses[0].resolve({ status: 'not_sure', answer: null });
    await tick();
    assert.equal(nodes(f.render(), 'Composer')[0].props.placeholder, 'Or type what to change');
    assert.equal(f.lines().includes('Enjoy Synthetic Cafe!'), false);
    f.send(); assert.equal(f.parses.at(-1).key, 'refine');
    assert.deepEqual(f.reminders, ['synthetic-user']); f.dispose();
  });
}

for (const kind of ['network', 'conflict']) {
  test(`delayed ${kind} after refinement stays with its original save`, async () => {
    const f = await fixture(); f.begin(); await f.refine(); f.feedback.length = 0;
    const cache = nodes(f.render(), 'ResultCards')[1].props.reasonsCache;
    const generation = cache.current();
    f.saves[0].reject(new ApiError(kind)); await tick();
    assert.equal(f.lines().includes('Already saved.'), false);
    assert.deepEqual(f.feedback, []);
    if (kind === 'network') {
      const retry = find(f.card(), 'Chip', 'Try again');
      retry.props.onPress(); retry.props.onPress();
      assert.equal(f.saves.length, 2);
      assert.deepEqual(f.saves[1].args, ['synthetic-session', 1, 'synthetic-place-1']);
      assert.equal(cache.current(), generation, 'Old retry must not invalidate the current reasons');
      f.saves[1].resolve({ logged: true }); await tick();
      assert.equal(f.lines().includes('Enjoy Synthetic Cafe!'), false);
      assert.deepEqual(f.feedback, []);
    }
    assert.deepEqual(f.reminders, kind === 'network' ? ['synthetic-user'] : []);
    f.send(); assert.equal(f.parses.at(-1).key, 'refine'); f.dispose();
  });
}

test('retry success in the unchanged conversation still confirms once without restarting ownership', async () => {
  const f = await fixture(); f.begin(); f.saves[0].reject(new ApiError('network')); await tick();
  const generation = nodes(f.render(), 'ResultCards')[0].props.reasonsCache.current();
  const retry = find(f.card(), 'Chip', 'Try again'); retry.props.onPress(); retry.props.onPress();
  assert.equal(f.saves.length, 2);
  assert.equal(nodes(f.render(), 'ResultCards')[0].props.reasonsCache.current(), generation);
  f.saves[1].resolve({ logged: true }); await tick();
  assert.deepEqual(f.feedback, ['success']); assert.deepEqual(f.reminders, ['synthetic-user']);
  assert.equal(f.lines().filter((line) => line === 'Enjoy Synthetic Cafe!').length, 1); f.dispose();
});

test('a failed old retry may fail again without cancelling a newer parse or reporting success', async () => {
  const f = await fixture(); f.begin(); f.saves[0].reject(new ApiError('network')); await tick();
  const retry = find(f.card(), 'Chip', 'Try again');
  f.send(); f.feedback.length = 0; retry.props.onPress();
  assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'thinking');
  f.saves[1].reject(new ApiError('network')); await tick();
  assert.equal(find(f.card(), 'Chip', 'Try again').props.label, 'Try again');
  assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'thinking');
  assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, []); f.dispose();
});

test('a stale card press during parsing cannot start a pick or cancel the current operation', async () => {
  const f = await fixture(); const button = find(f.card(), 'Chip', 'Pick this'); f.send();
  button.props.onPress();
  assert.equal(f.saves.length, 0);
  assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'thinking'); f.dispose();
});

test('a stale card event after new results, before card rerender, cannot save the prior round', async () => {
  const f = await fixture(); const button = find(f.card(), 'Chip', 'Pick this'); f.send();
  f.parses[0].resolve(parsed); await tick(); f.requests[1].resolve(result(2)); await tick();
  button.props.onPress(); assert.equal(f.saves.length, 0); f.dispose();
});

test('new search reset rejects a delayed earlier success and retains its legitimate saved-meal reminder', async () => {
  const f = await fixture(); f.begin(); await f.refine();
  // The first pick committed on the server; its response is delayed. The competing
  // pick receives the existing session conflict rather than creating a second meal.
  f.begin(1); f.saves[1].reject(new ApiError('conflict')); await tick();
  assert.equal(f.lines().includes('Already saved.'), false);
  assert.ok(nodes(f.card(1), 'Text').some((node) => node.props.children === 'Search already decided.'));
  f.send('Synthetic new craving'); assert.equal(f.parses[0].key, 'refine');
  assert.equal(f.parses.at(-1).key, 'craving');
  f.parses.at(-1).resolve({ status: 'not_sure', answer: null }); await tick();
  assert.ok(find(f.render(), 'Chip', 'Pizza')); // The new search is asking its first question.
  f.feedback.length = 0; f.saves[0].resolve({ logged: true }); await tick();
  assert.equal(f.lines().includes('Enjoy Synthetic Cafe!'), false);
  assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, ['synthetic-user']);
  // Completing the new search must send a fresh session, not the earlier one.
  for (const label of ['Pizza', '$', 'Close to me']) find(f.render(), 'Chip', label).props.onPress();
  await tick(); assert.equal(f.requests.at(-1).body.session_id, undefined); f.dispose();
});

test('unmount leaves the legitimate request alive without React, chat, haptic or reminder callbacks', async () => {
  const f = await fixture(); f.begin(); f.dispose();
  const updates = f.h.updates; f.saves[0].resolve({ logged: true }); await tick();
  assert.equal(f.saves.length, 1); assert.equal(f.h.updates, updates);
  assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, []);
});

for (const status of ['ok', 'network', 'conflict']) {
  test(`final None save ${status} uses the same ownership guard after refinement`, async () => {
    const f = await fixture({ final: true }); f.begin(0, 'None of these'); f.send();
    assert.equal(f.saves[0].kind, 'none'); assert.deepEqual(f.saves[0].args, ['synthetic-session']);
    f.feedback.length = 0;
    if (status === 'ok') f.saves[0].resolve({ logged: true }); else f.saves[0].reject(new ApiError(status));
    await tick();
    assert.equal(f.lines().includes('Got it, no pick this time.'), false);
    assert.equal(f.lines().includes('Already saved.'), false);
    assert.deepEqual(f.feedback, []); assert.deepEqual(f.reminders, []);
    if (status === 'network') assert.ok(find(f.card(), 'Chip', 'Try again'));
    f.dispose();
  });
}
