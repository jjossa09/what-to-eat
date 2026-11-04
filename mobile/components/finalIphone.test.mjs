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
  const jsx = (type, props, key) => ({ type, props, key });
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
  const animations = [], listeners = new Set(), keyboard = new Map();
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
  return { animations, listeners, keyboard, change(state) { AppState.currentState = state; listeners.forEach((fn) => fn(state)); },
    module: { ...Object.fromEntries(['View', 'Text', 'TextInput', 'Pressable', 'Modal', 'ScrollView',
      'KeyboardAvoidingView', 'ActivityIndicator', 'Image'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles, absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, hairlineWidth: 1 }, AppState,
    Animated: { Value, View: 'AnimatedView', Text: 'AnimatedText', createAnimatedComponent: (c) => `Animated${c}`,
      spring: animate, timing: animate, add: (...values) => values,
      parallel: () => ({ start() {}, stop() {} }) },
    Keyboard: { dismiss() {}, addListener: (event, callback) => {
      keyboard.set(event, callback); return { remove: () => keyboard.delete(event) };
    } },
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
    '../lib/profile': { loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }, { id: 'thai', name: 'Thai' }],
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
    'expo-blur': { BlurView: 'Blur' }, 'expo-linear-gradient': { LinearGradient: 'Gradient' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 59, bottom: 34 }) }, './PressScale': 'PressScale' });
}
function event() { return { stopped: false, stopPropagation() { this.stopped = true; } }; }


const flatten = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

test('Otis image overrides actual PNG intrinsic dimensions in normal and keyboard states', () => {
  const png = readFileSync(new URL('../assets/otis/otis_idle.png', import.meta.url));
  const intrinsic = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
  assert.deepEqual(intrinsic, { width: 512, height: 512 });
  const h = hooks(), rn = native();
  const Otis = load('./Otis.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    './otisAssets': { otisAssets: { idle: 1 } }, './GlassFrame': 'GlassFrame' }).default;
  for (const keyboard of [false, true, false]) {
    for (const state of ['idle', 'thinking', 'happy']) {
      const tree = h.flush(Otis, { keyboard, state, active: true });
      const frame = flatten(tree.props.style), image = nodes(tree, 'Image')[0];
      // Image.ios.js applies source dimensions before the supplied style. Absolute-fill alone
      // leaves the PNG at 512 pt; checking only the wrapper missed this regression before.
      const resolvedImage = { ...intrinsic, ...flatten(image.props.style) };
      assert.equal(resolvedImage.width, keyboard ? 60 : 64);
      assert.equal(resolvedImage.height, keyboard ? 60 : 64);
      assert.equal(frame.width - resolvedImage.width, 16);
      assert.equal(frame.height - resolvedImage.height, 16);
      assert.equal(resolvedImage.position, undefined);
      assert.equal(frame.alignSelf, 'center');
      assert.equal(frame.position, 'absolute');
      assert.equal(frame.top, 0);
      assert.equal(frame.transform, undefined);
      assert.equal(image.props.fadeDuration, 0);
      assert.equal(tree.props.pointerEvents, 'none');
      assert.equal(rn.animations.length, 0);
    }
  }
  h.unmount();
});

async function chatHost() {
  const h = hooks(), rn = native();
  let plans = 0;
  class Controller extends OtisController { constructor(ms) { super(ms, () => () => {}); } }
  const Chat = load('./Chat.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme,
    '@react-navigation/native': { useNavigation: () => ({ isFocused: () => true }),
      useFocusEffect: (callback) => h.react.useEffect(callback, [callback]) },
    '../lib/api': { getQuestionPlan: async () => {
      plans++;
      return { questions: ['craving', 'budget', 'distance'].map((key) => ({ key, prefill: null })) };
    },
      localTimeIso: () => '2026-11-01T12:00:00-05:00' },
    '../lib/profile': { loadTastePrior: async () => ({ favorites: ['pizza'], budget: 2, mostlySolo: true }),
      loadCategories: async () => [{ id: 'pizza', name: 'Pizza' }], loadDisplayName: async () => null,
      loadCompanionChoices: async () => [] },
    '../lib/location': { getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }) },
    '../lib/notify': {}, '../lib/haptics': {}, '../lib/questionPlan': questionPlan,
    '../lib/otis': { OtisController: Controller }, '../lib/reasons': { ReasonsCache },
    './Composer': 'Composer', './Otis': 'Otis', './ResultCards': 'ResultCards',
    './ScrollWithBar': 'ScrollWithBar', './TypingBubble': 'TypingBubble', './ui': hosts,
  }).default;
  const render = () => h.flush(Chat, { userId: 'synthetic-user', bottom: 100, onSignOut() {} });
  render(); await tick();
  return { h, rn, render, plans: () => plans };
}

test('Eat overlays Otis above the full safe-area scroll viewport through keyboard show and hide', async () => {
  const f = await chatHost(), ui = uiHost();
  const screen = flatten(ui.GlassScreen({ tabBar: true }).props.style);
  assert.equal(screen.paddingTop, 59 + theme.spacing.lg);
  for (const eventName of [null, 'keyboardWillShow', 'keyboardWillHide']) {
    if (eventName) f.rn.keyboard.get(eventName)();
    const tree = f.render(), content = nodes(tree, 'KeyboardAvoidingView')[0];
    const [thread, otis] = content.props.children;
    assert.equal(tree.type, 'GlassScreen');
    assert.equal(flatten(content.props.style).flex, 1);
    assert.equal(content.props.behavior, 'padding');
    assert.equal(otis.type, 'Otis');
    assert.equal(otis.props.keyboard, eventName === 'keyboardWillShow');
    assert.equal(thread.type, 'ScrollWithBar');
    assert.equal(flatten(thread.props.style).position, undefined);
    assert.equal(flatten(thread.props.contentContainerStyle).paddingTop, eventName === 'keyboardWillShow' ? 80 : 84);
    assert.ok(nodes(thread, 'Text').length > 0, 'first message stays inside the scroll region under the overlay');
  }
  f.h.unmount();
  assert.equal(f.rn.keyboard.size, 0);
});

function centeredLinks(tree) {
  const ui = uiHost();
  for (const label of ['Not now', "I didn't go", 'Skip']) {
    const link = nodes(tree, 'TextLink').find((node) => node.props.label === label);
    if (!link) continue;
    const parent = nodes(tree, 'View').find((node) => node.props.children === link);
    assert.equal(flatten(parent.props.style).alignSelf, 'center', label);
    assert.equal(flatten(parent.props.style).alignItems, 'center', label);
    // TextLink itself retains the existing shrink-to-content touch target and hitSlop.
    assert.equal(ui.TextLink(link.props).props.hitSlop, 12);
  }
}

test('last-meal card centers badge, wrapping title and secondary action without an empty progress row', async () => {
  const f = feedbackHost({ kind: 'ask', meal: { placeName: 'Synthetic restaurant with a very long name' } });
  const tree = await f.ready();
  const ui = uiHost(), card = ui.GlassCard(nodes(tree, 'GlassCard')[0].props);
  const body = card.props.children[2];
  assert.equal(flatten(body.props.style).gap, theme.spacing.lg);
  const title = nodes(tree, 'Text').find((node) => node.props.children === `Did you go to Synthetic restaurant with a very long name?`);
  assert.ok(title);
  assert.equal(flatten(title.props.style).textAlign, 'center');
  assert.equal(title.props.numberOfLines, undefined);
  assert.ok(nodes(tree, 'View').some((node) => flatten(node.props.style).alignSelf === 'center'
    && flatten(node.props.style).justifyContent === 'center'));
  assert.equal(nodes(tree, 'View').filter((node) => flatten(node.props.style).minHeight === theme.spacing.xxl).length, 0);
  centeredLinks(tree);
  f.h.unmount();
});

test('food, stars and price keep progress centered with equal side constraints and consistent option spacing', async () => {
  const f = feedbackHost({ kind: 'resumeFood', meal: { askPrice: true } });
  let tree = await f.ready();
  const options = nodes(tree, 'ScrollView')[0];
  assert.deepEqual(flatten(options.props.contentContainerStyle), {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: theme.spacing.sm,
  });
  assert.equal(flatten(nodes(tree, 'TextInput')[0].props.style).textAlign, 'center');
  assert.equal(nodes(tree, 'TextInput')[0].props.maxLength, 60);
  for (const at of ['food', 'stars', 'price']) {
    tree = f.render();
    const header = nodes(tree, 'View').find((node) => nodes(node, 'Dots').length === 1
      && flatten(node.props.style).flexDirection === 'row');
    const [left, dots, right] = header.props.children;
    assert.equal(dots.type, 'Dots');
    assert.equal(flatten(left.props.style).flex, 1);
    assert.deepEqual(flatten(right.props.style), flatten(left.props.style));
    assert.equal(flatten(header.props.style).alignItems, 'center');
    centeredLinks(tree);
    if (at === 'food') find(tree, 'PrimaryButton', 'Next').props.onPress();
    if (at === 'stars') {
      find(tree, 'PressScale', '4 stars').props.onPress(); f.render(); f.time.fire(350);
    }
  }
  f.h.unmount();
});

function pressControl(node, f, reduced = false) {
  const ui = uiHost(), host = pressHost();
  host.reduce(reduced);
  const control = node.type === 'PressScale' ? node : ui[node.type](node.props);
  const rendered = host.render(control.props);
  rendered.props.onPressIn(event()); rendered.props.onPressOut(event());
  rendered.props.onPress?.(event());
  f.seen.push(...host.seen);
  host.h.unmount();
  return { control: rendered, animations: host.rn.animations };
}

test('food selection has one feedback owner, skips unchanged and same-frame repeats and follows Reduce Motion', async () => {
  for (const reduced of [false, true]) {
    const f = feedbackHost({ kind: 'resumeFood' });
    let tree = await f.ready();
    const pizza = nodes(tree, 'Chip').find((node) => node.props.label.endsWith('Pizza'));
    pressControl(pizza, f, reduced);
    assert.deepEqual(f.seen, []);
    const thai = nodes(tree, 'Chip').find((node) => node.props.label.endsWith('Thai'));
    const result = pressControl(thai, f, reduced);
    pressControl(thai, f, reduced); // old render before state commits
    tree = f.render();
    pressControl(nodes(tree, 'Chip').find((node) => node.props.label.endsWith('Thai')), f, reduced);
    assert.deepEqual(f.seen, ['selection']);
    assert.equal(result.animations.length, reduced ? 0 : 2);
    assert.equal(f.calls.length, 0);
    f.h.unmount();
  }
});

test('ordinary Next and Back use one light haptic, with selection only for buffered stars', async () => {
  const f = feedbackHost({ kind: 'resumeFood', meal: { askPrice: true } });
  let tree = await f.ready();
  assert.deepEqual(f.seen, []);
  pressControl(find(tree, 'PrimaryButton', 'Next'), f);
  tree = f.render();
  pressControl(find(tree, 'TextLink', 'Back'), f);
  tree = f.render(); pressControl(find(tree, 'PrimaryButton', 'Next'), f);
  tree = f.render(); pressControl(find(tree, 'PressScale', '4 stars'), f);
  tree = f.render(); f.time.fire(350); tree = f.render();
  assert.deepEqual(f.seen, ['light', 'light', 'light', 'selection']);
  assert.deepEqual(f.calls, []);
  assert.equal(nodes(tree, 'Text').some((node) => node.props.children === 'About how much?'), true);
  f.h.unmount();
});

test('Not now, undo and Skip links disable animation, action and feedback while a save is pending', async () => {
  for (const label of ['Not now', "I didn't go", 'Skip']) {
    const wait = deferred(), f = feedbackHost({ kind: label === 'Not now' ? 'ask' : 'resumeFood',
      meal: { askPrice: true }, save: () => wait.promise });
    let tree = await f.ready();
    if (label === 'Not now') find(tree, 'Chip', 'Yes').props.onPress();
    else if (label === "I didn't go") find(tree, 'TextLink', label).props.onPress();
    else {
      find(tree, 'PrimaryButton', 'Next').props.onPress();
      find(f.render(), 'PressScale', '3 stars').props.onPress(); f.render(); f.time.fire(350);
      tree = f.render(); find(tree, 'Chip', '$$').props.onPress();
    }
    tree = f.render();
    const link = find(tree, 'TextLink', label), count = f.calls.length, seen = [...f.seen];
    const { control, animations } = pressControl(link, f);
    assert.equal(link.props.disabled, true);
    assert.equal(control.props.accessibilityState.disabled, true);
    assert.equal(control.props.onPress, undefined);
    assert.equal(animations.length, 0);
    assert.equal(f.calls.length, count);
    assert.deepEqual(f.seen, seen);
    nodes(tree, 'Modal')[0].props.onRequestClose(); wait.resolve(); await tick();
    assert.deepEqual(f.seen, seen);
    f.h.unmount();
  }
});

test('category changes cannot emit feedback or alter the pending food save through a stale handler', async () => {
  const wait = deferred(), f = feedbackHost({ kind: 'resumeFood', meal: { askStars: false }, save: () => wait.promise });
  const tree = await f.ready();
  const thai = nodes(tree, 'Chip').find((node) => node.props.label.endsWith('Thai'));
  find(tree, 'PrimaryButton', 'Done').props.onPress();
  thai.props.onPress();
  assert.deepEqual(f.seen, []);
  assert.deepEqual(f.calls.map((call) => call.answer), [{ category: 'pizza', dish: null }]);
  wait.resolve(); await tick();
  assert.deepEqual(f.seen, ['success']);
  f.h.unmount();
});

function glassOtisHost(liquid) {
  const mascot = hooks(), glass = hooks(), rn = native();
  let reduce = false;
  const Frame = load('./GlassFrame.tsx', { react: glass.react, 'react-native': rn.module, '../theme': theme,
    'expo-blur': { BlurView: 'Blur' },
    'expo-glass-effect': { GlassView: 'Glass', isLiquidGlassAvailable: () => liquid,
      isGlassEffectAPIAvailable: () => liquid },
    'react-native-svg': { __esModule: true, default: 'Svg', Defs: 'Defs', LinearGradient: 'Gradient', Rect: 'Rect', Stop: 'Stop' },
    '../lib/accessibility': { useReduceTransparency: () => reduce },
  }).default;
  const Otis = load('./Otis.tsx', { react: mascot.react, 'react-native': rn.module, '../theme': theme,
    './otisAssets': { otisAssets: { idle: 1 } }, './GlassFrame': Frame }).default;
  const render = (props = {}) => mascot.flush(Otis, { state: 'idle', active: true, keyboard: false, ...props });
  return { rn, render, reduce: (value) => { reduce = value; }, frame(tree) {
    const props = nodes(tree, Frame)[0].props;
    let rendered = glass.flush(Frame, props);
    rendered.props.onLayout({ nativeEvent: { layout: { width: props.size, height: props.size } } });
    rendered = glass.flush(Frame, props);
    return rendered;
  }, unmount() { mascot.unmount(); glass.unmount(); } };
}

test('Otis uses one circular native glass or blur surface with centered 8 pt artwork padding', () => {
  for (const liquid of [true, false]) {
    const f = glassOtisHost(liquid);
    for (const keyboard of [false, true, false]) {
      const tree = f.render({ keyboard }), frame = f.frame(tree);
      const diameter = keyboard ? 76 : 80, size = keyboard ? 60 : 64;
      assert.equal(flatten(frame.props.style).width, diameter);
      assert.equal(flatten(frame.props.style).height, diameter);
      assert.equal(flatten(frame.props.style).alignItems, 'center');
      assert.equal(flatten(frame.props.style).justifyContent, 'center');
      const clip = frame.props.children[0];
      assert.equal(flatten(clip.props.style).overflow, 'hidden');
      assert.equal(flatten(clip.props.style).borderRadius, diameter / 2);
      assert.equal(nodes(frame, 'Glass').length, liquid ? 1 : 0);
      assert.equal(nodes(frame, 'Blur').length, liquid ? 0 : 1);
      if (liquid) assert.equal(nodes(frame, 'Glass')[0].props.glassEffectStyle, theme.frame.frosted.glassStyle);
      else assert.equal(nodes(frame, 'Blur')[0].props.intensity, theme.frame.frosted.blurIntensity);
      const image = nodes(frame, 'Image')[0];
      assert.deepEqual(flatten(image.props.style), { width: size, height: size });
      assert.equal(image.props.source, 1);
      assert.equal(tree.props.pointerEvents, 'none');
      assert.equal(tree.props.accessibilityElementsHidden, true);
      assert.equal(f.rn.animations.length, 0);
    }
    f.unmount();
  }
});

test('Otis Reduce Transparency replaces native glass and blur with the established opaque circle', () => {
  for (const liquid of [true, false]) {
    const f = glassOtisHost(liquid), tree = f.render();
    for (const reduce of [false, true, false]) {
      f.reduce(reduce);
      const frame = f.frame(tree);
      assert.equal(nodes(frame, 'Glass').length + nodes(frame, 'Blur').length, reduce ? 0 : 1);
      assert.equal(nodes(frame, 'View').some((node) => flatten(node.props.style).backgroundColor === theme.frame.solidFill), reduce);
      assert.equal(nodes(frame, 'Image')[0].props.source, 1);
      assert.equal(flatten(frame.props.children[0].props.style).borderRadius, 40);
    }
    f.unmount();
  }
});

test('Eat initial inset clears the fixed circle by 4 pt and scrolls inside the full existing viewport', async () => {
  const f = await chatHost(), rn = native(), h = hooks(), events = [];
  Object.assign(rn.module.Animated, { ScrollView: 'NativeScroll', FlatList: 'NativeList', event: (mapping, config) => {
    events.push({ mapping, config }); return config.listener;
  } });
  const Scroll = load('./ScrollWithBar.tsx', { react: h.react, 'react-native': rn.module, '../theme': theme }).default;
  for (const keyboard of [false, true]) {
    if (keyboard) f.rn.keyboard.get('keyboardWillShow')();
    const tree = f.render(), [thread, overlay] = nodes(tree, 'KeyboardAvoidingView')[0].props.children;
    assert.equal(overlay.type, 'Otis'); // rendered after the scroll content for backdrop sampling
    const otis = glassOtisHost(false), circle = otis.render({ keyboard: overlay.props.keyboard });
    const inset = flatten(thread.props.contentContainerStyle).paddingTop;
    assert.equal(inset - flatten(circle.props.style).height, 4);
    assert.equal(flatten(circle.props.style).position, 'absolute');
    assert.equal(flatten(circle.props.style).top, 0);
    assert.equal(circle.props.pointerEvents, 'none');
    let scrollTree = h.flush(Scroll, thread.props);
    assert.equal(flatten(scrollTree.props.style).flex, 1);
    assert.equal(flatten(scrollTree.props.style).marginTop, undefined);
    assert.equal(nodes(scrollTree, 'NativeScroll').length, 1);
    assert.equal(nodes(scrollTree, 'NativeList').length, 0);
    const scroll = nodes(scrollTree, 'NativeScroll')[0];
    assert.equal(scroll.props.ref, thread.props.scrollRef);
    assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled');
    assert.equal(scroll.props.keyboardDismissMode, 'interactive');
    assert.equal(flatten(scroll.props.contentContainerStyle).paddingTop, inset);
    scroll.props.onLayout({ nativeEvent: { layout: { height: keyboard ? 280 : 620 } } });
    scroll.props.onContentSizeChange(390, 1800);
    scrollTree = h.flush(Scroll, thread.props);
    const thumb = nodes(scrollTree, 'AnimatedView')[0];
    assert.ok(thumb);
    const before = h.updates;
    scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
    assert.equal(h.updates, before, 'scrolling does not trigger React layout updates');
    assert.equal(events[0].config.useNativeDriver, true);
    otis.unmount();
  }
  h.unmount(); f.h.unmount();
});

test('Eat keyboard and ordinary rerenders retain scroll identity, auto-scroll and one initial plan request', async () => {
  const f = await chatHost(), tree = f.render();
  const thread = nodes(tree, 'ScrollWithBar')[0], overlay = nodes(tree, 'Otis')[0], calls = [];
  thread.props.scrollRef.current = { scrollToEnd: (options) => calls.push(options) };
  for (const eventName of [null, 'keyboardWillShow', 'keyboardWillHide', null]) {
    if (eventName) f.rn.keyboard.get(eventName)();
    const current = f.render(), next = nodes(current, 'ScrollWithBar')[0], otis = nodes(current, 'Otis')[0];
    assert.equal(next.type, thread.type);
    assert.equal(next.key, thread.key);
    assert.equal(next.props.scrollRef, thread.props.scrollRef);
    assert.equal(otis.type, overlay.type);
    assert.equal(otis.key, overlay.key);
    assert.equal(f.rn.listeners.size, 1);
    next.props.onContentSizeChange();
  }
  assert.deepEqual(calls, Array.from({ length: 4 }, () => ({ animated: true })));
  assert.equal(f.plans(), 1);
  f.h.unmount();
});

test('failed Otis artwork removes the glass and initial inset without affecting the conversation', async () => {
  const f = await chatHost(), tree = f.render(), props = nodes(tree, 'Otis')[0].props;
  const otis = glassOtisHost(false), mascot = otis.render(props);
  nodes(mascot, 'Image')[0].props.onError();
  assert.equal(otis.render(props), null);
  const next = f.render();
  assert.equal(flatten(nodes(next, 'ScrollWithBar')[0].props.contentContainerStyle).paddingTop, 0);
  assert.ok(nodes(next, 'Composer').length);
  assert.equal(f.plans(), 1);
  otis.unmount(); f.h.unmount();
});
