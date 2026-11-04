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
function timers() {
  const pending = new Set(), all = [];
  return { pending, all, globals: {
    setTimeout(fn, ms) { const timer = { fn, ms }; pending.add(timer); all.push(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
  }, fire(ms) { [...pending].filter((t) => t.ms === ms).forEach((t) => { pending.delete(t); t.fn(); }); } };
}
const hosts = { Chip: 'Chip', GlassCard: 'GlassCard', GlassScreen: 'GlassScreen', PrimaryButton: 'PrimaryButton',
  SecondaryButton: 'SecondaryButton', TextLink: 'TextLink', Dots: 'Dots' };
function feedbackHost(options = {}) {
  const h = hooks(), rn = native(), time = timers(), seen = [], calls = [];
  const meal = { id: 'synthetic-meal', placeName: 'Synthetic Cafe', categoryId: 'pizza', dish: null,
    pickedAt: new Date('2026-11-01T12:00:00Z'), askStars: true, askPrice: false, ...options.meal };
  const Prompt = load('./FeedbackPrompt.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '../lib/haptics': { haptic: (kind) => seen.push(kind) },
    '../lib/feedback': { MAX_DISH: 60,
      checkFeedback: async () => ({ start: { kind: options.kind ?? 'resumeStars', meal }, unanswered: null }),
      saveFeedback: async (id, answer) => { calls.push({ id, answer }); return options.save?.(answer); } },
    '../lib/notify': { cachePending() {}, onForeground() {}, reschedule() {}, stopReminder() {} },
    '../lib/profile': { loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }],
      BUDGETS: [{ level: 2, label: '$$' }] }, './PressScale': 'PressScale', './ui': hosts,
  }, time.globals).default;
  const render = () => h.flush(Prompt, { userId: 'synthetic-user' });
  render();
  return { h, rn, time, seen, calls, render, async ready() { await tick(); return render(); } };
}
function pressHost() {
  const h = hooks(), rn = native(), seen = [];
  let reduced = false;
  const Press = load('./PressScale.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '../lib/accessibility': { useReduceMotion: (conservative) => { assert.equal(conservative, true); return reduced; } },
    '../lib/haptics': { haptic: (kind) => seen.push(kind) },
  }).default;
  return { h, rn, seen, reduce: (value) => { reduced = value; }, render: (props) => h.flush(Press, props) };
}
function uiHost() {
  return load('./ui.tsx', { 'react-native': native().module, '../theme': theme,
    'expo-blur': { BlurView: 'Blur' }, 'expo-linear-gradient': {},
    'react-native-safe-area-context': {}, './PressScale': 'PressScale' });
}
function event() { return { stopped: false, stopPropagation() { this.stopped = true; } }; }

test('shared haptics map light, selection and success once and never run in background', async () => {
  const rn = native(), seen = [];
  const { haptic } = load('../lib/haptics.ts', { 'react-native': rn.module, 'expo-haptics': {
    ImpactFeedbackStyle: { Light: 'light' }, NotificationFeedbackType: { Success: 'success' },
    impactAsync: async (kind) => seen.push(kind), selectionAsync: async () => seen.push('selection'),
    notificationAsync: async (kind) => seen.push(kind),
  } });
  ['light', 'selection', 'success'].forEach(haptic);
  rn.change('background'); ['light', 'selection', 'success'].forEach(haptic);
  assert.deepEqual(seen, ['light', 'selection', 'success']);
  await tick();
});
test('unsupported or rejected haptics cannot interrupt an action', async () => {
  const { haptic } = load('../lib/haptics.ts', { 'react-native': native().module, 'expo-haptics': {
    ImpactFeedbackStyle: { Light: 'light' }, impactAsync() { throw Error('unsupported'); },
    selectionAsync: () => Promise.reject(Error('disabled')),
  } });
  assert.doesNotThrow(() => haptic('light')); haptic('selection'); await tick();
});
test('PressScale defaults silent, forwards one enabled action and suppresses disabled/read-only presses', () => {
  const f = pressHost(); let actions = 0;
  f.render({ onPress: () => actions++ }).props.onPress(event());
  assert.equal(actions, 1); assert.deepEqual(f.seen, []);
  f.render({ onPress: () => actions++, feedback: 'light' }).props.onPress(event());
  assert.equal(actions, 2); assert.deepEqual(f.seen, ['light']);
  for (const props of [{ disabled: true, onPress: () => actions++ }, {}]) {
    const tree = f.render({ ...props, feedback: 'light' });
    assert.equal(tree.props.disabled, true); assert.equal(tree.props.onPress, undefined);
    tree.props.onPressIn(event()); tree.props.onPressOut(event());
  }
  assert.equal(actions, 2); assert.deepEqual(f.seen, ['light']);
});
test('press cancellation springs back without haptics; Reduce Motion changes and unmount stop animation', () => {
  const f = pressHost(), props = { onPress() {}, feedback: 'light' };
  let tree = f.render(props);
  tree.props.onPressIn(event()); tree.props.onPressOut(event());
  assert.deepEqual(f.rn.animations.map((a) => a.config), [
    { toValue: 0.96, ...theme.motion.pressIn, useNativeDriver: true },
    { toValue: 1, ...theme.motion.release, useNativeDriver: true },
  ]);
  assert.deepEqual(f.seen, []);
  const scale = tree.props.style[1].transform[0].scale;
  f.reduce(true); tree = f.render(props); assert.equal(scale.value, 1); assert.ok(scale.stops >= 1);
  tree.props.onPressIn(event()); tree.props.onPressOut(event()); assert.equal(f.rn.animations.length, 2);
  tree.props.onPress(event()); assert.deepEqual(f.seen, ['light']);
  const stops = scale.stops; f.h.unmount(); assert.equal(scale.stops, stops + 1);
});
test('shared controls opt into light feedback, selection changes stay single-owned, repeated selections silent', () => {
  const ui = uiHost(), f = pressHost(); let changes = 0;
  for (const name of ['PrimaryButton', 'SecondaryButton', 'TextLink', 'Chip']) {
    const node = ui[name]({ label: 'Action', onPress: () => changes++ });
    f.render(node.props).props.onPress(event());
  }
  assert.equal(changes, 4); assert.deepEqual(f.seen, ['light', 'light', 'light', 'light']);
  for (const selected of [false, true]) {
    const node = ui.Chip({ label: 'Choice', selected, feedback: 'selection', onPress() {} });
    f.render(node.props).props.onPress(event());
  }
  assert.deepEqual(f.seen, ['light', 'light', 'light', 'light', 'selection']);
  const asyncNode = ui.PrimaryButton({ label: 'Save', feedback: false, onPress() {}, busy: true });
  assert.equal(f.render(asyncNode.props).props.onPress, undefined);
});
test('nested child control stops the parent event and emits one haptic without a second selection', () => {
  const child = pressHost(), parent = pressHost(); let childCalls = 0, parentCalls = 0;
  const e = event();
  child.render({ feedback: 'light', onPress: () => childCalls++ }).props.onPress(e);
  if (!e.stopped) parent.render({ feedback: 'selection', onPress: () => parentCalls++ }).props.onPress(e);
  assert.equal(childCalls, 1); assert.equal(parentCalls, 0);
  assert.deepEqual(child.seen, ['light']); assert.deepEqual(parent.seen, []);
});
test('Composer keyboard and button share one guarded send; typing and disabled submissions stay silent', () => {
  const h = hooks(), seen = [], sent = [];
  const Composer = load('./Composer.tsx', { react: h.react, 'react-native': native().module, '../theme': theme,
    './PressScale': 'PressScale', '../lib/haptics': { haptic: (kind) => seen.push(kind) } }).default;
  const render = (props = {}) => h.flush(Composer, { placeholder: 'Answer', onSend: (text) => sent.push(text), ...props });
  let tree = render(); nodes(tree, 'TextInput')[0].props.onSubmitEditing(); assert.deepEqual(seen, []);
  nodes(tree, 'TextInput')[0].props.onChangeText(' pizza '); tree = render();
  const input = nodes(tree, 'TextInput')[0], button = nodes(tree, 'PressScale')[0];
  input.props.onSubmitEditing(); button.props.onPress();
  assert.deepEqual(sent, ['pizza']); assert.deepEqual(seen, ['light']);
  tree = render(); nodes(tree, 'TextInput')[0].props.onChangeText('noodles'); tree = render({ busy: true });
  nodes(tree, 'TextInput')[0].props.onSubmitEditing(); assert.deepEqual(sent, ['pizza']);
});
test('final FeedbackPrompt star waits for successful save and emits exactly one confirmation', async () => {
  const wait = deferred(), f = feedbackHost({ save: () => wait.promise });
  const star = find(await f.ready(), 'PressScale', '4 stars');
  star.props.onPress(); star.props.onPress(); f.render();
  assert.deepEqual(f.seen, []); assert.equal(f.time.pending.size, 1);
  f.time.fire(350); await tick(); assert.deepEqual(f.calls, [{ id: 'synthetic-meal', answer: { stars: 4 } }]);
  assert.deepEqual(f.seen, []); wait.resolve(); await tick(); f.render();
  assert.deepEqual(f.seen, ['success']); assert.equal(f.time.pending.size, 1); f.h.unmount();
});
test('failed FeedbackPrompt star save stays quiet and retry confirms only after success', async () => {
  let failed = true;
  const f = feedbackHost({ save: async () => { if (failed) throw Error('offline'); } });
  find(await f.ready(), 'PressScale', '3 stars').props.onPress(); f.render(); f.time.fire(350); await tick();
  assert.deepEqual(f.seen, []); assert.equal(f.time.pending.size, 0);
  const retry = find(f.render(), 'Chip', 'Try again'); assert.equal(retry.props.feedback, false);
  failed = false; await retry.props.onPress(); f.render();
  assert.deepEqual(f.seen, ['success']); assert.equal(f.calls.length, 2); f.h.unmount();
});
test('buffered FeedbackPrompt star has selection only; passive price advance is silent and price save confirms once', async () => {
  const f = feedbackHost({ meal: { askPrice: true } });
  let tree = await f.ready(); const star = find(tree, 'PressScale', '4 stars');
  star.props.onPress(); star.props.onPress(); tree = f.render();
  assert.deepEqual(f.seen, ['selection']); f.time.fire(350); tree = f.render();
  assert.deepEqual(f.seen, ['selection']); assert.equal(f.calls.length, 0);
  const price = find(tree, 'Chip', '$$'); assert.equal(price.props.feedback, false);
  await price.props.onPress(); await tick(); f.render();
  assert.deepEqual(f.calls.map((c) => c.answer), [{ stars: 4 }, { priceTap: 2 }]);
  assert.deepEqual(f.seen, ['selection', 'success']); f.h.unmount();
});
test('rapid star replacement cancels the old callback and saves only the latest stars', async () => {
  const f = feedbackHost(); let tree = await f.ready();
  find(tree, 'PressScale', '2 stars').props.onPress(); tree = f.render();
  const stale = f.time.all.at(-1); find(tree, 'PressScale', '5 stars').props.onPress(); f.render();
  stale.fn(); await tick(); assert.equal(f.calls.length, 0);
  f.time.fire(350); await tick(); assert.deepEqual(f.calls.map((c) => c.answer), [{ stars: 5 }]); f.h.unmount();
});
test('dismissal and unmount cancel delayed FeedbackPrompt completion, including queued callbacks', async () => {
  for (const dismiss of [true, false]) {
    const f = feedbackHost(); let tree = await f.ready();
    find(tree, 'PressScale', '2 stars').props.onPress(); tree = f.render();
    const stale = f.time.all.at(-1);
    if (dismiss) nodes(tree, 'Modal')[0].props.onRequestClose(); else f.h.unmount();
    assert.equal(f.time.pending.size, 0); stale.fn(); await tick();
    assert.deepEqual(f.calls, []); assert.deepEqual(f.seen, []);
    if (dismiss) f.h.unmount(); assert.equal(f.rn.listeners.size, 0);
  }
});
test('backgrounding pauses delayed star completion and foreground resumes without duplicate listeners', async () => {
  const f = feedbackHost(); find(await f.ready(), 'PressScale', '5 stars').props.onPress(); f.render();
  const stale = f.time.all.at(-1); f.rn.change('background'); f.render(); stale.fn(); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.time.pending.size, 0);
  f.rn.change('active'); f.render(); f.time.fire(350); await tick();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.seen, ['success']);
  assert.equal(f.rn.listeners.size, 1); f.h.unmount(); assert.equal(f.rn.listeners.size, 0);
});
test('in-flight FeedbackPrompt save cannot celebrate, update state or continue writes after dismissal', async () => {
  const wait = deferred(), f = feedbackHost({ meal: { askPrice: true }, save: () => wait.promise });
  find(await f.ready(), 'PressScale', '2 stars').props.onPress(); f.render(); f.time.fire(350);
  let tree = f.render(); find(tree, 'Chip', '$$').props.onPress(); tree = f.render();
  nodes(tree, 'Modal')[0].props.onRequestClose(); f.render(); const updates = f.h.updates;
  wait.resolve(); await tick(); assert.deepEqual(f.seen, ['selection']); assert.equal(f.calls.length, 1);
  assert.equal(f.h.updates, updates); f.h.unmount();
});

function resultHost(save = async () => {}, readOnly = false) {
  const h = hooks(), seen = [], calls = [], interest = [], rn = native();
  class ApiError extends Error { constructor(kind) { super(kind); this.kind = kind; } }
  const Cards = load('./ResultCards.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '../lib/accessibility': {}, '../lib/haptics': { haptic: (kind) => seen.push(kind) },
    '../lib/api': { ApiError, logPicked: async (...args) => { calls.push(args); return save(); },
      logInterested: async (...args) => { interest.push(args); } },
    '../lib/places': { directionsUrl: () => 'https://maps.apple.com/' }, '../lib/reasons': {},
    './PlaceMap': { MiniMap: 'MiniMap', Attribution: 'Attribution' }, './PressScale': 'PressScale', './ui': hosts,
  }).default;
  const props = { picks: [{ id: 'synthetic-place', name: 'Synthetic Cafe', category: 'pizza', reason: 'Close by.',
    distance_m: 200, lat: 1, lon: 2 }], user: { lat: 1, lon: 2 }, reasonsCache: { isCurrent: () => false },
    generation: 0, userId: 'synthetic-user', sessionId: 'synthetic-session', round: 1, readOnly,
    onDecisionStart() {}, onSay() {}, onPicked() {}, active: true };
  return { h, seen, calls, interest, props, ApiError, render: () => h.flush(Cards, props) };
}
test('recommendation selection changes get selection feedback; read-only and repeated cards stay silent', () => {
  for (const readOnly of [false, true]) {
    const f = resultHost(undefined, readOnly); const card = nodes(f.render(), 'PressScale')[0];
    card.props.onPress(); card.props.onPress();
    assert.deepEqual(f.seen, readOnly ? [] : ['selection']); assert.equal(f.interest.length, 1); f.h.unmount();
  }
});
test('recommendation Pick owns one success after save, with a same-frame duplicate guard', async () => {
  const wait = deferred(), f = resultHost(() => wait.promise);
  const pick = find(f.render(), 'Chip', 'Pick this'); assert.equal(pick.props.feedback, false);
  pick.props.onPress(); pick.props.onPress(); assert.equal(f.calls.length, 1); assert.deepEqual(f.seen, []);
  wait.resolve(); await tick(); assert.deepEqual(f.seen, ['success']); f.h.unmount();
});
test('failed and already-saved picks never signal success; failed saves remain retryable', async () => {
  for (const conflict of [false, true]) {
    let failure = true;
    const f = resultHost(async () => { if (failure) throw conflict ? new f.ApiError('conflict') : Error('offline'); });
    find(f.render(), 'Chip', 'Pick this').props.onPress(); await tick(); assert.deepEqual(f.seen, []);
    if (!conflict) {
      failure = false; find(f.render(), 'Chip', 'Try again').props.onPress(); await tick();
      assert.deepEqual(f.seen, ['success']);
    }
    f.h.unmount();
  }
});
test('pick completion while hidden or unmounted cannot emit a delayed success', async () => {
  for (const unmount of [false, true]) {
    const wait = deferred(), f = resultHost(() => wait.promise);
    find(f.render(), 'Chip', 'Pick this').props.onPress();
    if (unmount) f.h.unmount(); else { f.props.active = false; f.render(); }
    wait.resolve(); await tick(); assert.deepEqual(f.seen, []); if (!unmount) f.h.unmount();
  }
});
test('distance segments reuse PressScale, selecting once preserves switch calculations and repeated selection is silent', () => {
  const h = hooks(), rn = native(), switches = [], selections = [], f = pressHost();
  const Chart = load('./charts/DistanceTimelineChart.tsx', {
    react: h.react, 'react-native': rn.module, 'react-native-svg': { Rect: 'Rect' }, '../../theme': theme,
    '../../lib/insights': {}, './BarChart': { ChartCard: 'ChartCard' },
    './OpeningMotion': { useTimelineSwitch: () => (count) => switches.push(count) }, '../PressScale': 'PressScale',
  }).default;
  const props = { selectedSlot: 'lunch', onSlotChange: (slot) => selections.push(slot), data: { timeline: [
    { id: 'lunch', label: 'Lunch', points: [] }, { id: 'dinner', label: 'Dinner', points: [{ distance_m: 10 }] },
  ] } };
  let tree = h.flush(Chart, props); const segments = nodes(tree, 'PressScale');
  f.render(segments[0].props).props.onPress(event()); f.render(segments[1].props).props.onPress(event());
  props.selectedSlot = 'dinner'; tree = h.flush(Chart, props);
  f.render(nodes(tree, 'PressScale')[1].props).props.onPress(event());
  assert.deepEqual(f.seen, ['selection']); assert.deepEqual(selections, ['dinner']); assert.deepEqual(switches, [1]);
});

function mealHost(write = async () => {}, reload = async () => {}) {
  const h = hooks(), rn = native(), seen = [], calls = [];
  const Card = load('./MealCard.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    'expo-blur': { BlurView: 'Blur' }, '../lib/accessibility': { useReduceMotion: () => false, useReduceTransparency: () => false },
    '../lib/feedback': { MAX_DISH: 60 }, '../lib/haptics': { haptic: (kind) => seen.push(kind) },
    '../lib/meals': { canEdit: () => true, mealWhen: () => 'Nov 1', slotLabel: () => 'Lunch',
      editMeal: async (id, edit) => { calls.push({ id, edit }); return write(); } },
    '../lib/profile': { BUDGETS: [{ level: 2, label: '$$' }] },
    './GlassFrame': 'GlassFrame', './PressScale': 'PressScale', './ui': hosts,
  }).default;
  const props = { meal: { id: 'synthetic-meal', dish: 'Pizza', stars: 3, priceTap: 2, priceLevel: 2,
    priceAmount: null, solo: true, companions: [], placeName: 'Synthetic Cafe', category: 'pizza', ateAnswered: true },
    from: { x: 20, y: 120, width: 350, height: 72 }, categoryName: () => 'Pizza', onClose() {}, onSaved: reload };
  const render = () => h.flush(Card, props);
  find(render(), 'PressScale', undefined).props.onPress(); // the sole edit control
  return { h, seen, calls, render };
}
test('meal edit confirms only changed successful saves, keeps no-op and failed edits quiet', async () => {
  for (const mode of ['unchanged', 'failure', 'success']) {
    const f = mealHost(async () => { if (mode === 'failure') throw Error('offline'); });
    let tree = f.render();
    if (mode !== 'unchanged') { nodes(tree, 'TextInput')[0].props.onChangeText('Noodles'); tree = f.render(); }
    const save = find(tree, 'PrimaryButton', 'Save'); assert.equal(save.props.feedback, false);
    await save.props.onPress(); f.render();
    assert.equal(f.calls.length, mode === 'unchanged' ? 0 : 1);
    if (f.calls.length) assert.deepEqual(f.calls[0], { id: 'synthetic-meal', edit: { dish: 'Noodles' } });
    assert.deepEqual(f.seen, mode === 'success' ? ['success'] : []); f.h.unmount();
  }
});
test('meal save duplicate guard preserves one write and dismissed edits cannot celebrate later', async () => {
  const wait = deferred(), f = mealHost(() => wait.promise);
  let tree = f.render(); nodes(tree, 'TextInput')[0].props.onChangeText('Noodles'); tree = f.render();
  const save = find(tree, 'PrimaryButton', 'Save'); save.props.onPress(); save.props.onPress();
  assert.equal(f.calls.length, 1); nodes(tree, 'Modal')[0].props.onRequestClose();
  wait.resolve(); await tick(); assert.deepEqual(f.seen, []); f.h.unmount();
});
test('meal star selection differs from filled-star appearance and repeating its value stays silent', () => {
  const f = mealHost(); let tree = f.render();
  find(tree, 'PressScale', '3 stars').props.onPress(); assert.deepEqual(f.seen, []);
  find(tree, 'PressScale', '2 stars').props.onPress(); tree = f.render();
  find(tree, 'PressScale', '2 stars').props.onPress(); assert.deepEqual(f.seen, ['selection']); f.h.unmount();
});
function quizHost(save = async () => {}) {
  const h = hooks(), seen = [], calls = [];
  const Quiz = load('./Quiz.tsx', { react: h.react, 'react-native': native().module, '../theme': theme,
    '../lib/haptics': { haptic: (kind) => seen.push(kind) },
    '../lib/profile': { MAX_FAVORITES: 5, BUDGETS: [{ level: 2, label: '$$' }],
      loadCategories: async () => Array.from({ length: 6 }, (_, i) => ({ id: `food-${i}`, name: `Food ${i}` })),
      saveTasteQuiz: async (answers) => { calls.push(answers); return save(); } },
    './PressScale': 'PressScale', './ui': hosts,
  }).default;
  const render = () => h.flush(Quiz, { onDone() {} }); render();
  return { h, seen, calls, render };
}
function advanceQuiz(f) {
  let tree = f.render(); find(tree, 'Chip', 'Food 0').props.onPress();
  find(f.render(), 'PrimaryButton', 'Next').props.onPress();
  find(f.render(), 'PrimaryButton', 'Skip').props.onPress();
  find(f.render(), 'Chip', '$$').props.onPress();
  return f.render();
}
test('quiz multi-select toggles own selection feedback and a sixth favorite remains silent', async () => {
  const f = quizHost(); await tick();
  for (let i = 0; i < 6; i++) {
    const chip = find(f.render(), 'Chip', `Food ${i}`); assert.equal(chip.props.feedback, false); chip.props.onPress();
  }
  assert.deepEqual(f.seen, Array(5).fill('selection'));
  find(f.render(), 'Chip', 'Food 0').props.onPress(); assert.equal(f.seen.length, 6); f.h.unmount();
});
test('quiz Solo final write is guarded and only success confirms; failures remain quiet', async () => {
  for (const failed of [false, true]) {
    const wait = deferred(), f = quizHost(() => wait.promise); await tick();
    const solo = find(advanceQuiz(f), 'Chip', 'Solo'); assert.equal(solo.props.feedback, false);
    f.seen.length = 0; solo.props.onPress(); solo.props.onPress(); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.seen, []); if (failed) wait.reject(Error('offline')); else wait.resolve();
    await tick(); assert.deepEqual(f.seen, failed ? [] : ['success']); f.h.unmount();
  }
});
test('quiz companion keyboard and Add have one owner and reject empty or duplicate names silently', async () => {
  const f = quizHost(); await tick();
  find(advanceQuiz(f), 'Chip', 'With people').props.onPress(); f.seen.length = 0;
  let tree = f.render(); nodes(tree, 'TextInput')[0].props.onChangeText('Synthetic Friend'); tree = f.render();
  nodes(tree, 'TextInput')[0].props.onSubmitEditing(); nodes(tree, 'PressScale')[0].props.onPress();
  assert.deepEqual(f.seen, ['light']); tree = f.render();
  nodes(tree, 'TextInput')[0].props.onChangeText('Synthetic Friend'); tree = f.render();
  nodes(tree, 'PressScale')[0].props.onPress(); assert.deepEqual(f.seen, ['light']); f.h.unmount();
});
test('name keyboard and button share a guarded save, with no success on failure or unmount', async () => {
  for (const mode of ['success', 'failure', 'unmount']) {
    const h = hooks(), wait = deferred(), seen = [], names = []; let done = 0;
    const Name = load('./NameStep.tsx', { react: h.react, 'react-native': native().module, '../theme': theme,
      '../lib/haptics': { haptic: (kind) => seen.push(kind) }, './ui': hosts,
      '../lib/profile': { setDisplayName: (name) => { names.push(name); return wait.promise; } },
    }).default;
    const render = () => h.flush(Name, { onDone: () => done++ });
    let tree = render(); nodes(tree, 'TextInput')[0].props.onChangeText('Synthetic Name'); tree = render();
    assert.equal(find(tree, 'PrimaryButton', 'Continue').props.feedback, false);
    nodes(tree, 'TextInput')[0].props.onSubmitEditing(); find(tree, 'PrimaryButton', 'Continue').props.onPress();
    assert.deepEqual(names, ['Synthetic Name']); assert.deepEqual(seen, []);
    if (mode === 'unmount') h.unmount();
    if (mode === 'failure') wait.reject(Error('offline')); else wait.resolve();
    await tick(); assert.deepEqual(seen, mode === 'success' ? ['success'] : []);
    assert.equal(done, mode === 'success' ? 1 : 0); if (mode !== 'unmount') h.unmount();
  }
});
function mapHost(save = async () => {}) {
  const h = hooks(), rn = native(), seen = [], searches = []; let focused = true;
  const place = { id: 'synthetic-place', name: 'Synthetic Cafe', category: 'pizza', lat: 1, lon: 2 };
  const Screen = load('../screens/MapScreen.tsx', { react: h.react, 'react-native': { ...rn.module, Easing: {} },
    '@react-navigation/native': { useNavigation: () => ({ navigate() {}, isFocused: () => focused }),
      useFocusEffect: (callback) => h.react.useEffect(callback, [callback]) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 50 }) },
    'react-native-maps': { __esModule: true, default: 'Map', Marker: 'Marker' }, '../theme': theme,
    '../components/GlassFrame': 'GlassFrame', '../components/PlaceMap': { Attribution: 'Attribution', EmojiPin: 'EmojiPin' },
    '../components/PressScale': 'PressScale', '../components/ui': { ...hosts, useTabBarSpace: () => 100 },
    '../lib/accessibility': { useReduceMotion: () => true }, '../lib/haptics': { haptic: (kind) => seen.push(kind) },
    '../lib/location': { getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }) },
    '../lib/profile': { loadCategories: async () => [] }, '../lib/places': {
      nearbyPlaces: async () => [place], mergePlaces: (_, found) => found, regionMoved: () => true,
      cachedSearch: () => null, regionSearch: (region) => region,
      searchArea: async (region) => { searches.push(region); await save(); return [place]; },
      distanceM: () => 100,
    },
  }).default;
  const render = () => h.flush(Screen); render();
  return { h, rn, seen, searches, render, hide: () => { focused = false; } };
}
test('Map native markers give selection feedback only on change and map gestures remain silent', async () => {
  const f = mapHost(); await tick(); let tree = f.render();
  const marker = nodes(tree, 'Marker')[0]; marker.props.onPress(); marker.props.onPress();
  assert.deepEqual(f.seen, ['selection']); tree = f.render();
  nodes(tree, 'Map')[0].props.onPress({ nativeEvent: { action: 'press' } });
  assert.deepEqual(f.seen, ['selection']); f.h.unmount();
});
test('Map area search has one request and confirmation after success, with no failure or hidden completion feedback', async () => {
  for (const mode of ['success', 'failure', 'hidden']) {
    const wait = deferred(), f = mapHost(() => wait.promise); await tick();
    let tree = f.render(); const map = nodes(tree, 'Map')[0];
    map.props.onRegionChangeComplete({ latitude: 1, longitude: 2 });
    map.props.onRegionChangeComplete({ latitude: 2, longitude: 3 }); tree = f.render();
    const search = nodes(tree, 'PressScale').find((node) => node.props.children?.props?.children === 'Search this area');
    assert.ok(search); search.props.onPress(); search.props.onPress();
    assert.equal(f.searches.length, 1); assert.deepEqual(f.seen, []);
    if (mode === 'hidden') f.hide(); if (mode === 'failure') wait.reject(Error('offline')); else wait.resolve();
    await tick(); assert.deepEqual(f.seen, mode === 'success' ? ['success'] : []); f.h.unmount();
  }
});

test('FeedbackPrompt went answer has one guarded confirmation; automatic likely-visit updates remain silent', async () => {
  const wait = deferred(), f = feedbackHost({ kind: 'ask', save: () => wait.promise });
  const yes = find(await f.ready(), 'Chip', 'Yes'); assert.equal(yes.props.feedback, false);
  yes.props.onPress(); yes.props.onPress(); assert.equal(f.calls.length, 1); assert.deepEqual(f.seen, []);
  wait.resolve(); await tick(); f.render(); assert.deepEqual(f.seen, ['success']); f.h.unmount();
  const passive = feedbackHost({ kind: 'likely' }); await passive.ready();
  assert.deepEqual(passive.calls.map((c) => c.answer), [{ went: true }]); assert.deepEqual(passive.seen, []);
  passive.h.unmount();
});
test('FeedbackPrompt preserves ordered food, stars and price writes, retrying only the unsaved answer', async () => {
  let failPrice = true;
  const f = feedbackHost({ kind: 'resumeFood', meal: { askPrice: true, dish: 'Synthetic dish' },
    save: async (answer) => { if ('priceTap' in answer && failPrice) throw Error('offline'); } });
  find(await f.ready(), 'PrimaryButton', 'Next').props.onPress();
  find(f.render(), 'PressScale', '4 stars').props.onPress(); f.render(); f.time.fire(350);
  await find(f.render(), 'Chip', '$$').props.onPress(); await tick();
  assert.deepEqual(f.calls.map((c) => c.answer), [
    { category: 'pizza', dish: 'Synthetic dish' }, { stars: 4 }, { priceTap: 2 },
  ]);
  assert.deepEqual(f.seen, ['selection']); failPrice = false;
  await find(f.render(), 'Chip', 'Try again').props.onPress(); await tick();
  assert.deepEqual(f.calls.map((c) => c.answer), [
    { category: 'pizza', dish: 'Synthetic dish' }, { stars: 4 }, { priceTap: 2 }, { priceTap: 2 },
  ]);
  assert.deepEqual(f.seen, ['selection', 'success']); f.h.unmount();
});
test('directions child owns its ordinary feedback and does not create a parent card interest event', () => {
  const f = resultHost(), ui = uiHost(), child = pressHost(); const tree = f.render();
  const directions = find(tree, 'Chip', 'Directions'); const e = event();
  child.render(ui.Chip(directions.props).props).props.onPress(e);
  if (!e.stopped) nodes(tree, 'PressScale')[0].props.onPress(e);
  assert.deepEqual(child.seen, ['light']); assert.deepEqual(f.seen, []);
  assert.deepEqual(f.interest, [['synthetic-session', 1, 'synthetic-place', 'directions']]); f.h.unmount();
});

async function chatHost(company = false) {
  const h = hooks(), rn = native(), seen = [], parse = deferred();
  let recommendations = 0;
  class Controller extends OtisController { constructor(ms) { super(ms, () => () => {}); } }
  const Chat = load('./Chat.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '@react-navigation/native': { useNavigation: () => ({ isFocused: () => true }),
      useFocusEffect: (callback) => h.react.useEffect(callback, [callback]) },
    '../lib/api': { getQuestionPlan: async () => ({ questions: [company ? 'company' : 'craving', 'budget', 'distance']
      .map((key) => ({ key, prefill: null })),
      skipped: company ? { key: 'craving', predicted: 'pizza', weak: false } : null }), parseAnswer: () => parse.promise,
      getRecommendations: () => { recommendations++; return new Promise(() => {}); },
      localTimeIso: () => '2026-11-01T12:00:00-05:00', deviceTimezone: () => 'America/New_York' },
    '../lib/location': { getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }) },
    '../lib/profile': { loadTastePrior: async () => ({ favorites: ['pizza'], budget: 2, mostlySolo: true }),
      loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }], loadDisplayName: async () => null,
      loadCompanionChoices: async () => company ? [{ id: 'synthetic-friend', name: 'Synthetic Friend' }] : [] },
    '../lib/notify': {},
    '../lib/haptics': { haptic: (kind) => seen.push(kind) }, '../lib/questionPlan': questionPlan,
    '../lib/otis': { OtisController: Controller }, '../lib/reasons': { ReasonsCache },
    './Composer': 'Composer', './Otis': 'Otis', './ResultCards': 'ResultCards',
    './ScrollWithBar': 'ScrollWithBar', './TypingBubble': 'TypingBubble', './ui': hosts,
  }).default;
  const render = () => h.flush(Chat, { userId: 'synthetic-user', bottom: 100, onSignOut() {} });
  render(); await tick();
  return { h, seen, render, counts: () => recommendations };
}
test('Eat chip choices own feedback, a preselected budget stays silent and exactly one round is requested', async () => {
  const f = await chatHost(); let tree = f.render();
  const craving = find(tree, 'Chip', 'Pizza'); assert.equal(craving.props.feedback, false); craving.props.onPress();
  tree = f.render(); const budget = find(tree, 'Chip', '$$');
  assert.equal(budget.props.selected, true); assert.equal(budget.props.feedback, false); budget.props.onPress();
  find(f.render(), 'Chip', 'Close to me').props.onPress(); await tick(); f.render();
  assert.deepEqual(f.seen, ['selection', 'selection']); assert.equal(f.counts(), 1); f.h.unmount();
});
test('Eat parsing refuses chip feedback while busy and the keyboard-dismiss backdrop stays native and silent', async () => {
  const f = await chatHost(); const tree = f.render();
  nodes(tree, 'Composer')[0].props.onSend('Synthetic craving');
  find(tree, 'Chip', 'Pizza').props.onPress(); assert.deepEqual(f.seen, []);
  const backdrop = nodes(f.render(), 'Pressable')[0]; assert.ok(backdrop);
  backdrop.props.onPress(); assert.deepEqual(f.seen, []); assert.equal(f.counts(), 0); f.h.unmount();
});
test('Eat Anything is an explicit selection, companion toggles own selection and Continue is one ordinary action', async () => {
  const any = await chatHost(); find(any.render(), 'Chip', 'Anything').props.onPress();
  assert.deepEqual(any.seen, ['selection']); any.h.unmount();
  const f = await chatHost(true); let tree = f.render();
  const companion = find(tree, 'Chip', 'Synthetic Friend'); assert.equal(companion.props.feedback, false);
  companion.props.onPress(); tree = f.render(); find(tree, 'Chip', 'Synthetic Friend').props.onPress(); tree = f.render();
  find(tree, 'Chip', 'Synthetic Friend').props.onPress(); tree = f.render();
  const next = find(tree, 'Chip', 'Continue'); assert.equal(next.props.feedback, false); next.props.onPress();
  assert.deepEqual(f.seen, ['selection', 'selection', 'selection', 'light']); f.h.unmount();
});
