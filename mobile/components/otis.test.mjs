import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

import { OtisController } from '../lib/otis.ts';
import * as questionPlan from '../lib/questionPlan.ts';
import { ReasonsCache, swapReason } from '../lib/reasons.ts';

// Execute real TSX and its effects in distinct render/commit phases. Native drawing and
// physics are stubbed; completion callbacks are controlled explicitly instead of slept on.
function load(file, imports = {}, expose = '') {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source + (expose ? `\nexport { ${expose} };` : ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const dependencies = { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, ...imports };
  new Function('require', 'module', 'exports', '__DEV__', outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unstubbed import: ${name}`);
    return dependencies[name];
  }, module, module.exports, false);
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
  let cursor = 0, dirty = false, effects = [], current;
  let updates = 0;
  const equal = (left, right) => left && right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) {
          slots[index].value = value;
          dirty = true;
          updates++;
        }
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
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
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
  const render = (Component, props) => {
    cursor = 0; dirty = false; effects = [];
    current = Component(props);
    return current;
  };
  const commit = () => { const pending = effects; effects = []; pending.forEach((effect) => effect()); };
  return {
    react, render, commit,
    get updates() { return updates; },
    flush(Component, props) {
      for (let attempt = 0; attempt < 20; attempt++) {
        render(Component, props); commit();
        if (!dirty) return current;
      }
      assert.fail('Render did not settle');
    },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function native() {
  const animations = [], loops = [], sequences = [], parallels = [], keyboard = new Map(), app = new Set();
  class Value {
    constructor(value) { this.value = value; }
    setValue(value) { this.value = value; }
  }
  const animate = (value, config) => {
    const run = { value, config, stopped: false,
      start(callback) { run.done = callback; animations.push(run); },
      stop() { run.stopped = true; },
    };
    return run;
  };
  const sequence = (steps) => {
    const run = { steps, stopped: false, start() {}, stop() { this.stopped = true; } };
    sequences.push(run);
    return run;
  };
  const parallel = (steps) => {
    const run = { steps, started: false, stopped: false,
      start() { this.started = true; },
      stop() { this.stopped = true; steps.forEach((step) => step.stop()); },
    };
    parallels.push(run);
    return run;
  };
  const module = {
    View: 'View', Text: 'Text', Pressable: 'Pressable', KeyboardAvoidingView: 'KeyboardAvoidingView', Image: 'Image',
    StyleSheet: { create: (styles) => styles, absoluteFill: {} },
    Animated: { Value, View: 'AnimatedView', Text: 'AnimatedText', timing: animate, spring: animate, sequence, parallel,
      loop: (run) => { loops.push(run); return run; } },
    Keyboard: { dismiss() {}, addListener: (event, callback) => {
      keyboard.set(event, callback);
      return { remove: () => keyboard.delete(event) };
    } },
    AppState: { currentState: 'active', addEventListener: (_, callback) => {
      app.add(callback);
      return { remove: () => app.delete(callback) };
    } },
  };
  return { module, animations, loops, sequences, parallels, keyboard, app };
}

function nodes(element, type) {
  if (!element || typeof element !== 'object') return [];
  return [...(element.type === type ? [element] : []),
    ...[element.props?.children].flat(Infinity).flatMap((child) => nodes(child, type))];
}
const flatten = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));


function cardsFixture(options = {}) {
  const h = hooks(), rn = native();
  let reduceMotion = false;
  const module = load('./ResultCards.tsx', {
    react: h.react, 'react-native': rn.module, '../theme': theme,
    '../lib/accessibility': { useReduceMotion: () => reduceMotion },
    '../lib/haptics': { haptic() {} },
    '../lib/api': { getReasons: options.request }, '../lib/places': {},
    '../lib/reasons': { ReasonsCache, swapReason }, './PressScale': 'PressScale',
    './PlaceMap': { MiniMap: 'MiniMap', Attribution: 'Attribution' }, './ui': { Chip: 'Chip', GlassCard: 'GlassCard' },
  }, 'ReasonText');
  return { ...module, h, rn, setReduceMotion: (value) => { reduceMotion = value; } };
}

function lineProps(overrides = {}) {
  return { id: 'node/101', template: 'Close by.', cache: new ReasonsCache(), generation: 0, active: true,
    ...overrides };
}

test('reason completion occurs after text commit and the final fade, never at response or fade-out', () => {
  const f = cardsFixture();
  const seen = [];
  const props = lineProps({ lifecycle: { current: () => true, displayed: (id) => seen.push(id) } });
  f.h.flush(f.ReasonText, props);
  props.enhanced = 'A validated nearby option.';
  assert.equal(f.h.render(f.ReasonText, props).props.children, 'Close by.');
  assert.deepEqual(seen, []);
  f.h.commit();
  f.rn.animations[0].done({ finished: true });
  assert.equal(f.h.render(f.ReasonText, props).props.children, props.enhanced);
  f.h.commit();
  assert.deepEqual(seen, []);
  f.rn.animations[1].done({ finished: true });
  assert.deepEqual(seen, []);
  f.h.render(f.ReasonText, props);
  assert.deepEqual(seen, []);
  f.h.commit();
  assert.deepEqual(seen, ['node/101']);
  f.h.flush(f.ReasonText, { ...props, active: false });
  f.h.flush(f.ReasonText, props);
  assert.equal(f.rn.animations.length, 2);
  assert.deepEqual(seen, ['node/101']);
  f.h.unmount();
});

test('unchanged validated lines complete after commit without an animation or extra state update', () => {
  const f = cardsFixture();
  let shown = 0;
  const props = lineProps({ enhanced: 'Close by.', lifecycle: { current: () => true, displayed: () => { shown++; } } });
  f.h.render(f.ReasonText, props);
  assert.equal(shown, 0);
  f.h.commit();
  assert.equal(shown, 1);
  assert.equal(f.rn.animations.length, 0);
  assert.equal(f.h.updates, 0);
});

test('Reduce Motion during a fade cancels it, commits the new line and ignores the old callback', () => {
  const f = cardsFixture();
  let shown = 0;
  const props = lineProps({ enhanced: 'A validated nearby option.',
    lifecycle: { current: () => true, displayed: () => { shown++; } } });
  f.h.flush(f.ReasonText, props);
  const old = f.rn.animations[0];
  f.setReduceMotion(true);
  const tree = f.h.flush(f.ReasonText, props);
  assert.equal(tree.props.children, props.enhanced);
  assert.equal(old.stopped, true);
  assert.equal(shown, 1);
  old.done({ finished: true });
  f.h.flush(f.ReasonText, props);
  assert.equal(shown, 1);
  assert.equal(f.rn.animations.length, 1);
});

test('hiding during a reason fade snaps to the final text with no background animation', () => {
  const f = cardsFixture();
  let shown = 0;
  const props = lineProps({ enhanced: 'A validated nearby option.',
    lifecycle: { current: () => true, displayed: () => { shown++; } } });
  f.h.flush(f.ReasonText, props);
  const tree = f.h.flush(f.ReasonText, { ...props, active: false });
  assert.equal(tree.props.children, props.enhanced);
  assert.equal(f.rn.animations[0].stopped, true);
  assert.equal(shown, 1);
  f.h.flush(f.ReasonText, props);
  assert.equal(f.rn.animations.length, 1);
});

test('unmounted lines and invalidated operations cannot report stale display completion', () => {
  for (const cancel of ['unmount', 'cache', 'operation']) {
    const f = cardsFixture();
    let shown = 0, current = true;
    const props = lineProps({ enhanced: 'A validated nearby option.',
      lifecycle: { current: () => current, displayed: () => { shown++; } } });
    f.h.flush(f.ReasonText, props);
    f.rn.animations[0].done({ finished: true });
    f.h.flush(f.ReasonText, props);
    if (cancel === 'unmount') f.h.unmount();
    else if (cancel === 'cache') props.cache.invalidate();
    else current = false;
    f.rn.animations[1].done({ finished: true });
    if (cancel !== 'unmount') f.h.flush(f.ReasonText, props);
    assert.equal(shown, 0);
  }
});

const picks = ['node/101', 'node/102', 'node/103'].map((id) => ({
  id, name: 'Synthetic place', category: 'pizza', lat: 1, lon: 2, distance_m: 100, reason: 'Close by.',
}));
const reasons = { source: 'muse', reasons: picks.map((pick) => ({ id: pick.id, line: 'A validated nearby option.' })) };
function cardsProps(overrides = {}) {
  return { picks, reasonsCache: new ReasonsCache(), generation: 0, userId: 'synthetic-user',
    sessionId: 'synthetic-session', round: 1, envelope: { payload: 'synthetic', signature: 'synthetic' }, ...overrides };
}

test('ResultCards reports ineligible enhancements as fallback without making a request', () => {
  for (const override of [{ envelope: null }, { sessionId: null }, { round: null }, { final: true }]) {
    let fallback = 0;
    const f = cardsFixture({ request: () => assert.fail('Must not request enhancement') });
    f.h.flush(f.default, cardsProps({ ...override, lifecycle: { fallback: () => { fallback++; } } }));
    assert.equal(fallback, 1);
  }
});

test('ResultCards fallback settles once and visibility/rerenders do not repeat failed requests', async () => {
  let calls = 0, fallback = 0;
  const f = cardsFixture({ request: async () => { calls++; throw new Error('timeout'); } });
  const props = cardsProps({ lifecycle: { fallback: () => { fallback++; } } });
  f.h.flush(f.default, props);
  await tick();
  f.h.flush(f.default, { ...props, active: false });
  f.h.flush(f.default, props);
  await tick();
  assert.equal(calls, 1);
  assert.equal(fallback, 1);
  assert.equal(nodes(f.h.flush(f.default, props), f.ReasonText)[0].props.enhanced, undefined);
  f.h.unmount();
});

test('a remounted ResultCards consumes cached validated lines without another request or celebration', async () => {
  let calls = 0;
  const controller = new OtisController(1200, () => () => {});
  controller.setActive(true);
  const token = controller.begin();
  const lifecycle = controller.observeReasons(token, {
    userId: 'synthetic-user', sessionId: 'synthetic-session', round: 1, generation: 0,
  }, picks.map((pick) => pick.id));
  const props = cardsProps({ lifecycle });
  const request = async () => { calls++; return reasons; };
  for (let mount = 0; mount < 2; mount++) {
    const f = cardsFixture({ request });
    f.setReduceMotion(true);
    f.h.flush(f.default, props);
    await tick();
    const tree = f.h.flush(f.default, props);
    assert.equal(nodes(tree, f.ReasonText).length, 3);
    for (const reason of nodes(tree, f.ReasonText)) {
      const line = cardsFixture();
      line.setReduceMotion(true);
      line.h.flush(line.ReasonText, reason.props);
      line.h.unmount();
    }
    assert.equal(controller.getSnapshot().state, mount === 0 ? 'happy' : 'idle');
    f.h.unmount();
    if (mount === 0) controller.setActive(false);
    // A cached remount after returning must stay idle, not celebrate again.
    if (mount === 0) controller.setActive(true);
  }
  assert.equal(calls, 1);
  controller.cancel();
});

function mascotFixture(assets) {
  const h = hooks(), rn = native();
  let reduceMotion = false, motionReads = 0;
  const Otis = load('./Otis.tsx', {
    react: h.react, 'react-native': rn.module, '../theme': theme,
    '../lib/accessibility': { useReduceMotion: () => { motionReads++; return reduceMotion; } },
    './otisAssets': { otisAssets: assets },
    './GlassFrame': 'GlassFrame',
  }).default;
  return { h, rn, Otis, setReduceMotion: (value) => { reduceMotion = value; },
    get motionReads() { return motionReads; } };
}

function staticImage(tree) {
  assert.equal(tree.type, 'View');
  assert.equal(nodes(tree, 'View').length, 1);
  assert.equal(nodes(tree, 'AnimatedView').length, 0);
  const images = nodes(tree, 'Image');
  assert.equal(images.length, 1);
  return images[0];
}

function assertNoMascotWork(f) {
  assert.equal(f.rn.animations.length, 0);
  assert.equal(f.rn.loops.length, 0);
  assert.equal(f.rn.sequences.length, 0);
  assert.equal(f.rn.parallels.length, 0);
  assert.equal(f.rn.keyboard.size, 0);
  assert.equal(f.rn.app.size, 0);
  assert.equal(f.motionReads, 0);
}

test('missing artwork fixture renders nothing, reserves no header and starts no animation', () => {
  const f = mascotFixture(null);
  assert.equal(f.h.flush(f.Otis, { state: 'thinking', active: true, keyboard: false }), null);
  assert.equal(f.rn.animations.length + f.rn.loops.length, 0);
});

test('production Otis loads only idle while all three approved RGBA PNGs remain on disk', () => {
  for (const state of ['idle', 'thinking', 'happy']) {
    const png = readFileSync(new URL(`../assets/otis/otis_${state}.png`, import.meta.url));
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
    assert.equal(png[24], 8);
    assert.equal(png[25], 6);
  }
  // A Thinking/Happy require fails the strict loader, even if no image were mounted.
  const assets = load('./otisAssets.ts', { '../assets/otis/otis_idle.png': 1 }).otisAssets;
  assert.deepEqual(assets, { idle: 1 });
  const f = mascotFixture(assets);
  for (const state of ['idle', 'thinking', 'happy']) {
    for (const active of [true, false]) {
      const tree = f.h.flush(f.Otis, { state, active, keyboard: false });
      assert.equal(staticImage(tree).props.source, 1);
    }
  }
  assertNoMascotWork(f);
  f.h.unmount();
});

test('static Otis retains 64/60 pt artwork inside padded glass and decorative noninteractive accessibility', () => {
  const f = mascotFixture({ idle: 1 });
  for (const state of ['idle', 'thinking', 'happy']) {
    for (const keyboard of [false, true]) {
      const tree = f.h.flush(f.Otis, { state, active: true, keyboard });
      const style = flatten(tree.props.style), image = staticImage(tree);
      assert.equal(style.width, keyboard ? 76 : 80);
      assert.equal(style.height, keyboard ? 76 : 80);
      assert.equal(style.position, 'absolute');
      assert.equal(style.top, 0);
      assert.equal(style.alignSelf, 'center');
      const glass = nodes(tree, 'GlassFrame')[0];
      assert.equal(glass.props.size, style.width);
      assert.equal(glass.props.shape, 'circle');
      assert.equal(glass.props.variant, 'frosted');
      assert.equal(style.transform, undefined);
      assert.equal(style.opacity, undefined);
      assert.equal(tree.props.pointerEvents, 'none');
      assert.equal(tree.props.accessible, false);
      assert.equal(tree.props.accessibilityElementsHidden, true);
      assert.equal(tree.props.importantForAccessibility, 'no-hide-descendants');
      assert.equal(image.props.accessible, false);
      assert.equal(image.props.resizeMode, 'contain');
      assert.equal(image.props.fadeDuration, 0);
      assert.deepEqual(flatten(image.props.style), { width: keyboard ? 60 : 64, height: keyboard ? 60 : 64 });
    }
  }
  assertNoMascotWork(f);
  f.h.unmount();
});

test('state, visibility, keyboard and Reduce Motion changes start no animations, timers or listeners', (t) => {
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('Static Otis must not schedule timers'));
  t.mock.method(globalThis, 'setInterval', () => assert.fail('Static Otis must not schedule intervals'));
  const f = mascotFixture({ idle: 1 });
  for (const reduced of [false, true, false]) {
    f.setReduceMotion(reduced);
    for (const active of [true, false, true]) {
      for (const state of ['idle', 'thinking', 'happy', 'thinking', 'idle']) {
        for (const keyboard of [false, true]) {
          const tree = f.h.flush(f.Otis, { state, active, keyboard });
          assert.equal(staticImage(tree).props.source, 1);
          assert.equal(flatten(tree.props.style).transform, undefined);
          assertNoMascotWork(f);
        }
      }
    }
  }
  assert.equal(f.h.updates, 0);
  f.h.unmount();
  assertNoMascotWork(f);
});

test('happy and rapid cancelled state changes keep the idle image without a fade or bounce', () => {
  const f = mascotFixture({ idle: 1 });
  for (const state of ['happy', 'thinking', 'happy', 'idle', 'thinking', 'idle']) {
    const tree = f.h.flush(f.Otis, { state, active: true, keyboard: false });
    assert.equal(staticImage(tree).props.source, 1);
    assert.equal(flatten(tree.props.style).transform, undefined);
    assert.equal(flatten(tree.props.style).opacity, undefined);
    assertNoMascotWork(f);
  }
  f.h.unmount();
});

test('failed idle artwork removes the mascot and its spacing without retrying on state or focus changes', () => {
  const f = mascotFixture({ idle: 1 });
  const tree = f.h.flush(f.Otis, { state: 'idle', active: true, keyboard: false });
  staticImage(tree).props.onError();
  for (const state of ['idle', 'thinking', 'happy']) {
    for (const active of [true, false]) {
      assert.equal(f.h.flush(f.Otis, { state, active, keyboard: true }), null);
    }
  }
  assertNoMascotWork(f);
  f.h.unmount();
});

test('a supplied replacement asset recovers from failure and null artwork keeps no reserved space', () => {
  const f = mascotFixture({ idle: 1 });
  const props = { state: 'thinking', active: true, keyboard: false };
  staticImage(f.h.flush(f.Otis, props)).props.onError();
  assert.equal(f.h.flush(f.Otis, props), null);
  assert.equal(f.h.flush(f.Otis, { ...props, assets: null }), null);
  const replacement = { idle: 2 };
  const tree = f.h.flush(f.Otis, { ...props, assets: replacement });
  assert.equal(staticImage(tree).props.source, 2);
  assert.equal(flatten(tree.props.style).width, 80);
  staticImage(tree).props.onError();
  assert.equal(f.h.flush(f.Otis, { ...props, assets: replacement }), null);
  assertNoMascotWork(f);
  f.h.unmount();
});

test('conservative motion waits for the preference and ignores an older read after a change', async () => {
  const h = hooks(), pending = deferred();
  let change, removed = false;
  const module = load('../lib/accessibility.ts', { react: h.react, 'react-native': { AccessibilityInfo: {
    isReduceMotionEnabled: () => pending.promise,
    addEventListener: (_, callback) => { change = callback; return { remove: () => { removed = true; } }; },
  } } });
  const Hook = () => module.useReduceMotion(true);
  assert.equal(h.flush(Hook), true);
  change(true);
  pending.resolve(false);
  await tick();
  assert.equal(h.flush(Hook), true);
  h.unmount();
  assert.equal(removed, true);
});

test('existing accessibility defaults are preserved and conservative read failures stay still', async () => {
  for (const conservative of [false, true]) {
    const h = hooks();
    const module = load('../lib/accessibility.ts', { react: h.react, 'react-native': { AccessibilityInfo: {
      isReduceMotionEnabled: async () => { throw new Error('unavailable'); },
      addEventListener: () => ({ remove() {} }),
    } } });
    const Hook = () => module.useReduceMotion(conservative);
    assert.equal(h.flush(Hook), conservative);
    await tick();
    assert.equal(h.flush(Hook), conservative);
    h.unmount();
  }
});

async function chatFixture() {
  const h = hooks(), rn = native(), response = deferred(), enhancement = deferred(), parse = deferred();
  const controllers = [], focus = new Set();
  let focused = true, recommendationCalls = 0, reasonCalls = 0, planCalls = 0;
  const navigation = { isFocused: () => focused };
  class Controller extends OtisController {
    constructor(ms) { super(ms, () => () => {}); controllers.push(this); }
  }
  const Chat = load('./Chat.tsx', {
    react: h.react, 'react-native': rn.module, '../theme': theme,
    '@react-navigation/native': { useNavigation: () => navigation,
      useFocusEffect: (effect) => h.react.useEffect(() => {
        let cleanup;
        const update = () => { cleanup?.(); cleanup = focused ? effect() : undefined; };
        focus.add(update); update();
        return () => { focus.delete(update); cleanup?.(); };
      }, [effect]) },
    '../lib/api': {
      getQuestionPlan: async () => { planCalls++; return { questions: ['craving', 'budget', 'distance']
        .map((key) => ({ key, prefill: null })) }; },
      getRecommendations: () => { recommendationCalls++; return response.promise; },
      parseAnswer: () => parse.promise,
      localTimeIso: () => '2026-11-03T12:00:00-05:00', deviceTimezone: () => 'America/New_York',
    },
    '../lib/location': { getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }) },
    '../lib/profile': { loadTastePrior: async () => ({ favorites: ['pizza'], budget: 2, mostlySolo: true }),
      loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }], loadDisplayName: async () => null,
      loadCompanionChoices: async () => [] },
    '../lib/notify': {}, '../lib/haptics': { haptic() {} },
    '../lib/questionPlan': questionPlan, '../lib/otis': { OtisController: Controller },
    '../lib/reasons': { ReasonsCache }, './Composer': 'Composer', './Otis': 'Otis', './ResultCards': 'ResultCards',
    './ScrollWithBar': 'ScrollWithBar', './TypingBubble': 'TypingBubble', './ui': { Chip: 'Chip', GlassScreen: 'Screen' },
  }).default;
  const props = { userId: 'synthetic-user', bottom: 108, onSignOut() {} };
  const render = () => h.flush(Chat, props);
  render(); await tick();
  for (const label of ['Pizza', '$', 'Close to me']) {
    const chip = nodes(render(), 'Chip').find((node) => node.props.label === label);
    assert.ok(chip, `Missing ${label} chip`);
    chip.props.onPress();
  }
  await tick();
  assert.equal(nodes(render(), 'Otis')[0].props.state, 'thinking');
  response.resolve({ session_id: 'synthetic-session', round: 1, logged: true, picks,
    answers: { craving: 'pizza', budget_level: 1, radius_m: 15000, exclude_categories: [] },
    reasons_envelope: { payload: 'synthetic', signature: 'synthetic' }, best_so_far: false, next_question: null });
  await tick();
  const tree = render();
  const card = nodes(tree, 'ResultCards')[0];
  const cards = cardsFixture({ request: () => { reasonCalls++; return enhancement.promise; } });
  const cardProps = () => nodes(render(), 'ResultCards')[0].props;
  const setFocus = (value) => { focused = value; focus.forEach((update) => update()); };
  const setApp = (value) => { rn.module.AppState.currentState = value; rn.app.forEach((callback) => callback(value)); };
  return { h, rn, tree, render, card, cardProps, cards, enhancement, parse, controllers, setFocus, setApp,
    counts: () => ({ recommendationCalls, reasonCalls, planCalls }) };
}

test('actual Eat keeps thinking after template cards and settles only after all current reason commits', async () => {
  const f = await chatFixture();
  assert.equal(nodes(f.tree, 'Otis')[0].props.state, 'thinking');
  const layout = nodes(f.tree, 'KeyboardAvoidingView')[0].props.children;
  assert.equal(layout[0].type, 'ScrollWithBar');
  assert.equal(layout[1].type, 'Otis');
  assert.ok(nodes(f.tree, 'Text').some((node) => node.props.children === 'Finishing reasons…'
    && node.props.accessibilityLiveRegion === 'polite'));
  f.cards.h.flush(f.cards.default, f.cardProps());
  f.enhancement.resolve(reasons); await tick();
  const tree = f.cards.h.flush(f.cards.default, f.cardProps());
  assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'thinking');
  for (const [index, reason] of nodes(tree, f.cards.ReasonText).entries()) {
    const line = cardsFixture();
    line.setReduceMotion(true);
    line.h.flush(line.ReasonText, reason.props);
    assert.equal(nodes(f.render(), 'Otis')[0].props.state, index === 2 ? 'happy' : 'thinking');
    line.h.unmount();
  }
  assert.deepEqual(f.counts(), { recommendationCalls: 1, reasonCalls: 1, planCalls: 1 });
  f.rn.keyboard.get('keyboardWillShow')();
  assert.equal(nodes(f.render(), 'Otis')[0].props.keyboard, true);
  f.h.unmount(); f.cards.h.unmount();
  assert.equal(f.rn.app.size, 0);
  assert.equal(f.rn.keyboard.size, 0);
});

test('Eat focus and app backgrounding suppress hidden completions without another enhancement call', async () => {
  for (const hide of ['tab', 'app']) {
    const f = await chatFixture();
    if (hide === 'tab') f.setFocus(false);
    else f.setApp('background');
    assert.equal(nodes(f.render(), 'Otis')[0].props.active, false);
    f.cards.h.flush(f.cards.default, f.cardProps());
    f.enhancement.resolve(reasons); await tick();
    const tree = f.cards.h.flush(f.cards.default, f.cardProps());
    for (const reason of nodes(tree, f.cards.ReasonText)) {
      const line = cardsFixture();
      line.h.flush(line.ReasonText, reason.props);
      line.h.unmount();
    }
    if (hide === 'tab') f.setFocus(true);
    else f.setApp('active');
    assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'idle');
    f.cards.h.flush(f.cards.default, f.cardProps());
    await tick();
    assert.deepEqual(f.counts(), { recommendationCalls: 1, reasonCalls: 1, planCalls: 1 });
    f.h.unmount(); f.cards.h.unmount();
  }
});

test('Eat rejection and pick-start cancel the actual round observer before late completions', async () => {
  for (const action of ['onNoneOfThese', 'onDecisionStart']) {
    const f = await chatFixture();
    const lifecycle = f.card.props.lifecycle;
    f.card.props[action]();
    assert.equal(lifecycle.current(), false);
    lifecycle.accepted(); picks.forEach((pick) => lifecycle.displayed(pick.id)); lifecycle.fallback();
    assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'idle');
    assert.equal(f.rn.app.size, 1);
    f.h.unmount();
  }
});

test('typed parsing thinks, invalidates the prior round and settles idle on an uncertain answer', async () => {
  const f = await chatFixture();
  const lifecycle = f.card.props.lifecycle;
  nodes(f.render(), 'Composer')[0].props.onSend('Synthetic unclear reply');
  let tree = f.render();
  assert.equal(nodes(tree, 'Otis')[0].props.state, 'thinking');
  assert.equal(nodes(tree, 'TypingBubble').length, 1);
  assert.equal(lifecycle.current(), false);
  f.parse.resolve({ status: 'not_sure', answer: null, source: 'none', reply: null });
  await tick();
  tree = f.render();
  assert.equal(nodes(tree, 'Otis')[0].props.state, 'idle');
  assert.equal(nodes(tree, 'TypingBubble').length, 0);
  lifecycle.accepted(); picks.forEach((pick) => lifecycle.displayed(pick.id));
  assert.equal(nodes(f.render(), 'Otis')[0].props.state, 'idle');
  assert.equal(f.counts().recommendationCalls, 1);
  f.h.unmount();
});
