import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the real TSX callbacks with inert native hosts. This checks event wiring and
// rendered props without installing a renderer; native layout and spring physics need iPhone.
function load(file, imports = {}, expose = '') {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source + (expose ? `\nexport { ${expose} };` : ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  const jsx = (type, props) => ({ type, props });
  const dependencies = { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, ...imports };
  new Function('require', 'module', 'exports', outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unstubbed import: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const theme = load('../theme.ts');

function hooks(initial = []) {
  const slots = [...initial];
  let cursor = 0;
  let effects = [];
  let cleanups = [];
  const state = (value) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value;
    return [slots[index], (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next;
    }];
  };
  return {
    react: {
      useState: state, useRef: (value) => state(() => ({ current: value }))[0],
      useEffect: (effect) => { effects.push(effect); }, useCallback: (fn) => fn,
      useId: () => 'synthetic-frame',
    },
    render(Component, props) { cursor = 0; effects = []; return Component(props); },
    mountEffects() { cleanups = effects.map((effect) => effect()); },
    unmount() { cleanups.forEach((cleanup) => cleanup?.()); },
  };
}

function native() {
  const springs = [];
  const timings = [];
  const events = [];
  class Value {
    constructor(value) { this.value = value; this.stopped = false; }
    setValue(value) { this.value = value; }
    interpolate(config) { return { value: this, config }; }
    stopAnimation() { this.stopped = true; }
  }
  const animation = (calls) => (value, config) => ({
    start: () => { calls.push({ value, config }); }, stop: () => {},
  });
  const module = {
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', Modal: 'Modal',
    StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Animated: {
      Value, View: 'AnimatedView', ScrollView: 'AnimatedScrollView', FlatList: 'AnimatedFlatList',
      createAnimatedComponent: (component) => `Animated${component}`,
      spring: animation(springs), timing: animation(timings),
      add: (...values) => values,
      parallel: () => ({ start() {}, stop() {} }),
      event: (mapping, config) => {
        events.push({ mapping, config });
        return config.listener;
      },
    },
    PanResponder: { create: (handlers) => ({ panHandlers: handlers }) },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
  return { module, springs, timings, events };
}

function flatten(style) {
  return Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
}

function nodes(element, type) {
  if (!element || typeof element !== 'object') return [];
  return [
    ...(element.type === type ? [element] : []),
    ...[element.props?.children].flat(Infinity).flatMap((child) => nodes(child, type)),
  ];
}

function navigationHarness(reduceMotion = false) {
  const home = hooks();
  const button = hooks();
  const rn = native();
  const haptics = [];
  const PressScale = load('./PressScale.tsx', {
    react: button.react, 'react-native': rn.module, '../theme': theme,
    '../lib/accessibility': { useReduceMotion: () => reduceMotion },
    '../lib/haptics': { haptic: (kind) => haptics.push(kind) },
  }).default;
  const imports = Object.fromEntries([
    './components/AuthScreen', './components/Chat', './components/Dock', './components/FeedbackPrompt',
    './components/NameStep', './components/Quiz', './screens/MapScreen', './screens/MealsScreen',
    './screens/ProfileScreen', '@expo/vector-icons/Ionicons',
  ].map((name) => [name, name]));
  const { HomeTabs } = load('../App.tsx', {
    ...imports, react: home.react, 'react-native': rn.module, './theme': theme,
    '@react-navigation/bottom-tabs': { createBottomTabNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '@react-navigation/native': { DefaultTheme: { colors: {} }, NavigationContainer: 'Navigation' },
    'expo-status-bar': {}, 'react-native-safe-area-context': {},
    './components/PressScale': PressScale,
    './components/ui': { useDockBottom: () => 34 },
    './lib/notify': {}, './lib/profile': {}, './lib/supabase': {},
    './lib/haptics': { haptic: (kind) => haptics.push(kind) },
  }, 'HomeTabs');
  const render = () => nodes(home.render(HomeTabs, { userId: 'synthetic-user' }), 'Navigator')[0];
  const profile = (navigator) => nodes(navigator, 'Screen').find((screen) => screen.props.name === 'Profile').props.children();
  const listener = (navigator, route, focused) => navigator.props.screenListeners({
    route: { name: route }, navigation: { isFocused: () => focused },
  }).tabPress;
  return { render, profile, listener, home, button, rn, haptics, PressScale };
}

test('normal tab changes emit one light haptic and active-tab retaps stay silent', () => {
  const h = navigationHarness();
  for (const route of ['Eat', 'Map', 'Meals', 'Profile']) {
    h.listener(h.render(), route, true)();
    assert.equal(h.haptics.length, 0);
  }
  for (const route of ['Eat', 'Map', 'Meals', 'Profile']) h.listener(h.render(), route, false)();
  assert.deepEqual(h.haptics, ['light', 'light', 'light', 'light']);
});

test('Profile from Insights follows the shared press-in/release spring and closes once with one haptic', () => {
  const h = navigationHarness();
  let navigator = h.render();
  const renderButton = navigator.props.screenOptions({ route: { name: 'Profile' } }).tabBarButton;
  h.profile(navigator).props.onInsightsChange(true);
  navigator = h.render();
  assert.equal(h.profile(navigator).props.showInsights, true);
  const options = navigator.props.screenOptions({ route: { name: 'Profile' } });
  assert.equal(options.tabBarButton, renderButton);
  let presses = 0;
  const element = renderButton({ role: 'button', 'aria-selected': true, accessibilityLabel: 'Profile',
    onPress: () => { presses++; h.listener(navigator, 'Profile', true)(); },
  });
  assert.equal(element.type, h.PressScale);
  const press = h.button.render(element.type, element.props);
  assert.equal(press.props.role, 'button');
  assert.equal(press.props['aria-selected'], true);
  assert.equal(press.props.accessibilityLabel, 'Profile');
  press.props.onPressIn({});
  press.props.onPressOut({});
  press.props.onPress();
  assert.deepEqual(h.rn.springs.map(({ config }) => config), [
    { toValue: 0.96, ...theme.motion.pressIn, useNativeDriver: true },
    { toValue: 1, ...theme.motion.release, useNativeDriver: true },
  ]);
  const scale = flatten(press.props.style).transform[0].scale;
  assert.equal(h.rn.springs[0].value, scale);
  assert.equal(h.rn.springs[1].value, scale);
  navigator = h.render();
  assert.equal(h.profile(navigator).props.showInsights, false);
  assert.deepEqual(h.haptics, ['light']);
  assert.equal(presses, 1);
  assert.equal(navigator.props.screenOptions({ route: { name: 'Profile' } }).tabBarButton, renderButton);
  h.listener(navigator, 'Profile', true)();
  assert.deepEqual(h.haptics, ['light']);
});

test('returning to Profile from another tab with Insights open emits only one haptic', () => {
  const h = navigationHarness();
  h.profile(h.render()).props.onInsightsChange(true);
  h.listener(h.render(), 'Profile', false)();
  assert.equal(h.profile(h.render()).props.showInsights, false);
  assert.deepEqual(h.haptics, ['light']);
});

test('Reduce Motion suppresses tab springs while retaining the Profile action and light haptic', () => {
  const h = navigationHarness(true);
  h.profile(h.render()).props.onInsightsChange(true);
  const navigator = h.render();
  const renderButton = navigator.props.screenOptions({ route: { name: 'Profile' } }).tabBarButton;
  const element = renderButton({ onPress: h.listener(navigator, 'Profile', true) });
  const press = h.button.render(element.type, element.props);
  press.props.onPressIn({});
  press.props.onPressOut({});
  press.props.onPress();
  assert.equal(h.rn.springs.length, 0);
  assert.deepEqual(h.haptics, ['light']);
  assert.equal(h.profile(h.render()).props.showInsights, false);
});

test('Insights back row precedes the title, centers its contents and preserves back navigation', () => {
  const react = hooks();
  const rn = native();
  let back;
  let removed = false;
  rn.module.BackHandler = { addEventListener: (_, callback) => {
    back = callback;
    return { remove: () => { removed = true; } };
  } };
  let cleanup;
  const Screen = load('../screens/InsightsScreen.tsx', {
    react: react.react, 'react-native': rn.module, '../theme': theme,
    '@expo/vector-icons/Ionicons': 'Icon',
    '@react-navigation/native': { useFocusEffect: (effect) => { cleanup = effect(); } },
    '../components/charts/InsightCharts': {}, '../components/charts/OpeningMotion': { OpeningMotion: 'Opening' },
    '../components/PressScale': 'PressScale', '../components/ScrollWithBar': 'ScrollWithBar',
    '../components/ui': { GlassScreen: 'Screen', ScreenTitle: 'Title', useTabBarSpace: () => 108 },
    '../lib/insights': {}, '../lib/api': {},
  }).default;
  let closes = 0;
  const tree = react.render(Screen, { state: { status: 'loading' }, onClose: () => { closes++; } });
  const content = nodes(tree, 'Screen')[0].props.children;
  assert.equal(content[1].type, 'Title');
  assert.equal(content[1].props.children, 'Insights');
  const row = nodes(content[0], 'PressScale')[0];
  assert.equal(row.props.accessibilityLabel, 'Back to Profile');
  assert.equal(row.props.style.minHeight, 44);
  assert.equal(row.props.style.alignItems, 'center');
  assert.equal(row.props.style.flexDirection, 'row');
  assert.equal(nodes(row, 'Text')[0].props.children, 'Profile');
  row.props.onPress();
  assert.equal(closes, 1);
  assert.equal(back(), true);
  assert.equal(closes, 2);
  cleanup();
  assert.equal(removed, true);
});

test('GlassScreen retains safe-area padding and its shared 20 pt gutter', () => {
  const rn = native();
  const { GlassScreen } = load('./ui.tsx', {
    'react-native': rn.module, '../theme': theme, './PressScale': 'PressScale',
    'expo-blur': { BlurView: 'Blur' }, 'expo-linear-gradient': { LinearGradient: 'Gradient' },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 59, bottom: 34 }) },
  });
  const tab = flatten(GlassScreen({ tabBar: true }).props.style);
  assert.deepEqual(tab, { flex: 1, paddingHorizontal: 20, paddingTop: 75, paddingBottom: 0 });
  assert.equal(flatten(GlassScreen({}).props.style).paddingBottom, 50);
});

function scrollHarness() {
  const react = hooks();
  const rn = native();
  const module = load('./ScrollWithBar.tsx', { react: react.react, 'react-native': rn.module, '../theme': theme });
  return { ...module, react, rn, render: (props) => react.render(module.default, props) };
}

test('scroll geometry hides short content and clamps the minimum thumb to a small viewport', () => {
  const { scrollGeometry } = scrollHarness();
  for (const [view, content] of [[0, 2000], [500, 0], [500, 500], [500, 501]]) {
    assert.equal(scrollGeometry(view, content).scrollable, false);
  }
  assert.deepEqual(scrollGeometry(500, 2000), { scrollable: true, thumb: 125, range: 1500, travel: 375 });
  assert.deepEqual(scrollGeometry(20, 2000), { scrollable: true, thumb: 20, range: 1980, travel: 0 });
});

test('scroll viewport and dock use the same 20 pt gutter with the thumb outside card edges', () => {
  const h = scrollHarness();
  let tree = h.render({});
  const scroll = nodes(tree, 'AnimatedScrollView')[0];
  scroll.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  scroll.props.onContentSizeChange(390, 2000);
  tree = h.render({});
  const outer = flatten(tree.props.style);
  const content = flatten(nodes(tree, 'AnimatedScrollView')[0].props.contentContainerStyle);
  const thumb = flatten(nodes(tree, 'AnimatedView')[0].props.style);
  assert.equal(theme.layout.gutter, 20);
  assert.equal(theme.dock.sideInset, 20);
  assert.equal(outer.marginHorizontal, -20);
  assert.equal(content.paddingHorizontal, 20);
  for (const width of [320, 390, 430]) {
    assert.equal(20 + outer.marginHorizontal, 0);
    assert.ok(width - thumb.right - thumb.width > width - content.paddingHorizontal);
  }
  assert.equal(thumb.right, 3);
  assert.equal(thumb.width, 5);
  assert.deepEqual(thumb.transform[0].translateY.config, {
    inputRange: [0, 1500], outputRange: [0, 375], extrapolate: 'clamp',
  });
});

test('FlatList mode keeps data and row rendering virtualized without a nested ScrollView', () => {
  const h = scrollHarness();
  const data = Array.from({ length: 200 }, (_, index) => ({ id: `synthetic-${index}` }));
  let rendered = 0;
  const renderItem = () => { rendered++; };
  const tree = h.render({ list: { data, keyExtractor: (meal) => meal.id, renderItem },
    contentContainerStyle: { paddingBottom: 108 },
  });
  assert.equal(nodes(tree, 'AnimatedScrollView').length, 0);
  const list = nodes(tree, 'AnimatedFlatList')[0];
  assert.equal(list.props.data, data);
  assert.equal(list.props.renderItem, renderItem);
  assert.equal(rendered, 0);
  assert.equal(list.props.keyExtractor(data[199]), 'synthetic-199');
  assert.deepEqual(flatten(list.props.contentContainerStyle), { paddingHorizontal: 20, paddingBottom: 108 });
  assert.equal(list.props.showsVerticalScrollIndicator, false);
  assert.equal(h.rn.events[0].config.useNativeDriver, true);
});

test('shared scroll preserves chat refs, keyboard options, auto-scroll, refresh and dock clearance', () => {
  const h = scrollHarness();
  const calls = [];
  const ref = { current: { scrollToEnd: (options) => calls.push(options) } };
  const refreshControl = { type: 'RefreshControl' };
  const props = { scrollRef: ref, keyboardShouldPersistTaps: 'handled', keyboardDismissMode: 'interactive',
    refreshControl, contentContainerStyle: { paddingBottom: 108 },
    onContentSizeChange: () => ref.current.scrollToEnd({ animated: true }),
  };
  const scroll = nodes(h.render(props), 'AnimatedScrollView')[0];
  assert.equal(scroll.props.ref, ref);
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled');
  assert.equal(scroll.props.keyboardDismissMode, 'interactive');
  assert.equal(scroll.props.refreshControl, refreshControl);
  assert.equal(flatten(scroll.props.contentContainerStyle).paddingBottom, 108);
  scroll.props.onContentSizeChange(390, 2000);
  assert.deepEqual(calls, [{ animated: true }]);
  scroll.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
  const thumb = nodes(h.render(props), 'AnimatedView')[0];
  scroll.props.onScroll();
  assert.equal(h.rn.events.length, 1);
  h.react.mountEffects();
  h.react.unmount();
  assert.equal(flatten(thumb.props.style).opacity.stopped, true);
});

function glass(liquid, reduce) {
  const react = hooks();
  const rn = native();
  const Frame = load('./GlassFrame.tsx', {
    react: react.react, 'react-native': rn.module, '../theme': theme,
    'expo-blur': { BlurView: 'Blur' },
    'expo-glass-effect': { GlassView: 'Glass', isLiquidGlassAvailable: () => liquid,
      isGlassEffectAPIAvailable: () => liquid },
    'react-native-svg': { __esModule: true, default: 'Svg', Defs: 'Defs', LinearGradient: 'Gradient', Rect: 'Rect', Stop: 'Stop' },
    '../lib/accessibility': { useReduceTransparency: () => reduce },
  }).default;
  return (variant) => react.render(Frame, { shape: 'rounded', variant });
}

test('frosted glass adds a readable fill on native glass and blur; default map glass stays clear', () => {
  for (const liquid of [true, false]) {
    const render = glass(liquid, false);
    const frosted = render('frosted');
    const clear = render(undefined);
    if (liquid) {
      assert.equal(nodes(frosted, 'Glass')[0].props.glassEffectStyle, 'regular');
      assert.equal(nodes(clear, 'Glass')[0].props.glassEffectStyle, 'clear');
    } else {
      assert.equal(nodes(frosted, 'Blur')[0].props.intensity, 40);
      assert.equal(nodes(clear, 'Blur')[0].props.intensity, 20);
    }
    assert.ok(nodes(frosted, 'View').some((view) => flatten(view.props.style).backgroundColor === theme.colors.glassFrosted));
    assert.ok(!nodes(clear, 'View').some((view) => flatten(view.props.style).backgroundColor === theme.colors.glassFrosted));
  }
});

test('Reduce Transparency gives both GlassFrame variants an opaque theme fill', () => {
  for (const variant of ['clear', 'frosted']) {
    const tree = glass(true, true)(variant);
    assert.equal(nodes(tree, 'Glass').length + nodes(tree, 'Blur').length, 0);
    assert.ok(nodes(tree, 'View').some((view) => flatten(view.props.style).backgroundColor === theme.colors.gradient[0]));
  }
});

test('primary and secondary meal text exceed 4.5:1 over the frosted fill even on a black backdrop', () => {
  const alpha = Number(theme.frame.frosted.fill.match(/[\d.]+/g).at(-1));
  const luminance = (rgb) => rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const background = luminance([alpha, alpha, alpha]);
  for (const color of [theme.colors.text, theme.colors.textSecondary]) {
    const rgb = color.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255);
    assert.ok((background + 0.05) / (luminance(rgb) + 0.05) >= 4.5);
  }
});

test('long meal values are untruncated inside the detail scroll, preserving Edit and swipe at the top', () => {
  const react = hooks();
  const rn = native();
  const { default: MealCard, Line } = load('./MealCard.tsx', {
    react: react.react, 'react-native': rn.module, '../theme': theme,
    'expo-blur': { BlurView: 'Blur' }, '../lib/accessibility': { useReduceMotion: () => false, useReduceTransparency: () => false },
    '../lib/feedback': { MAX_DISH: 200 }, '../lib/profile': { BUDGETS: [] },
    '../lib/haptics': { haptic() {} },
    '../lib/meals': { canEdit: () => true, mealWhen: () => 'Nov 3', slotLabel: () => 'Dinner' },
    './GlassFrame': 'Frame', './PressScale': 'PressScale', './ui': {},
  }, 'Line');
  const meal = { id: 'synthetic-meal', source: 'live', category: 'pizza', placeName: 'Synthetic restaurant with a long name',
    eatenOn: '2026-11-03', mealSlot: 'dinner', stars: 4, went: true, pickedAt: null,
    dish: 'A long synthetic dish description to check complete text', ateAnswered: true,
    solo: true, companions: [], priceTap: 2, priceLevel: 2, priceAmount: null };
  const tree = react.render(MealCard, { meal, from: { x: 20, y: 100, width: 350, height: 90 }, categoryName: () => 'Pizza' });
  assert.equal(nodes(tree, 'Frame')[0].props.variant, 'frosted');
  const details = nodes(tree, 'ScrollView')[0];
  assert.ok(nodes(details, 'Text').some((text) => text.props.children === meal.placeName && text.props.numberOfLines === undefined));
  assert.equal(nodes(details, 'PressScale')[0].props.accessibilityRole, 'button');
  const value = nodes(Line({ label: 'Had', value: meal.dish }), 'Text')[1];
  assert.equal(value.props.children, meal.dish);
  assert.equal(value.props.numberOfLines, undefined);
  const card = nodes(tree, 'AnimatedView').find((view) => view.props.onMoveShouldSetPanResponder);
  const drag = { dy: 30, dx: 0 };
  assert.equal(card.props.onMoveShouldSetPanResponder(null, drag), true);
  details.props.onScroll({ nativeEvent: { contentOffset: { y: 100 } } });
  assert.equal(card.props.onMoveShouldSetPanResponder(null, drag), false);
  details.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
  assert.equal(card.props.onMoveShouldSetPanResponder(null, drag), true);
});
