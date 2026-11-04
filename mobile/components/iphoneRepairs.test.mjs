import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as protocol from '../lib/companion.ts';

// Execute the production handlers and JSX with synthetic service boundaries. This proves
// state transitions and rendered controls, not native iPhone layout or live model quality.
function load(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unstubbed dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return text(tree.props?.children);
}
function hooks() {
  const slots = []; let cursor = 0; let effects = [];
  const state = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  return { reset() { cursor = 0; }, commit() { const pending = effects; effects = []; pending.forEach((fn) => fn()); },
    react: { Fragment: 'Fragment', useState: state, useRef: (initial) => state(() => ({ current: initial }))[0],
      useCallback: (fn) => fn, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useEffect: (fn, deps) => {
        const index = cursor++; const before = slots[index];
        if (!before || deps.some((value, i) => value !== before[i])) { slots[index] = deps; effects.push(fn); }
      } } };
}
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const theme = load('../theme.ts', {});
const categories = [{ id: 'chinese', name: 'Chinese' }, { id: 'mexican', name: 'Mexican' },
  { id: 'japanese_sushi', name: 'Japanese/Sushi' }, { id: 'chicken_wings', name: 'Chicken/Wings' }];
const people = [{ id: '00000000-0000-0000-0000-000000000079', name: 'Synthetic Alex' }];
const rn = { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} }, Linking: {},
  StyleSheet: { create: (styles) => styles }, ActivityIndicator: 'Spinner', KeyboardAvoidingView: 'Avoid',
  Pressable: 'Pressable', Text: 'Text', TextInput: 'Input', View: 'View' };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const meal = (changes = {}) => ({ type: 'log_meal', category: null, dish: null, date: null,
  slot: null, place_name: null, company: [], solo: null, stars: null, ...changes });

async function chat(options = {}) {
  const h = hooks(); let tree; let turn = 0;
  const requests = [];
  class ApiError extends Error {}
  const api = { ApiError, localTimeIso: () => '2026-11-04T19:00:00-05:00', deviceTimezone: () => 'America/New_York',
    companionCall: async (path, body) => {
      requests.push({ path, body });
      if (path === '/conversation/parse') return options.interpretations[turn++];
      if (path === '/conversation/context') return { conversation_id: '00000000-0000-0000-0000-000000000075' };
      if (path === '/conversation/plan') {
        const state = structuredClone(body.state);
        for (const key of protocol.SURVEY_KEYS) if (body.patch?.[key]) {
          state[key] = { ...body.patch[key], source: body.source, turn: 1 };
        }
        return { state, ready: options.ready ?? false, next_key: 'budget',
          conversation_id: '00000000-0000-0000-0000-000000000075' };
      }
      if (path.endsWith('/prepare')) return { id: 'synthetic-action', state: 'pending', arguments: body.arguments };
      if (path.endsWith('/confirm')) {
        if (options.saveError) throw new Error('Synthetic save failure');
        return options.saveResult ?? { status: 'saved', meal_id: 'synthetic-meal' };
      }
      if (path.endsWith('/cancel')) return { cancelled: true };
      if (path.startsWith('/places/search?')) {
        if (options.lookupError) throw options.lookupError;
        return options.lookupResult ?? { places: [], widened: true, truncated: false };
      }
      throw new Error(`Unexpected request ${path}`);
    },
    getRecommendations: async (body) => {
      requests.push({ path: '/recommendations', body });
      return { session_id: 'synthetic-session', round: 1, logged: true, best_so_far: false,
        answers: { craving: body.craving, budget_level: body.budget_level, radius_m: body.radius_m, exclude_categories: [] },
        required_craving: body.craving,
        picks: typeof options.picks === 'function' ? options.picks(body) : options.picks ?? [], next_question: null };
    },
  };
  const actions = load('../lib/companionActions.ts', { './api': api, './companion': protocol });
  class Cache { generation = 0; clear() {} invalidate() { this.generation++; } current() { return this.generation; } isCurrent(g) { return g === this.generation; } }
  class Otis { subscribe() {} getSnapshot() { return { active: true, state: options.thinking ? 'thinking' : 'idle' }; }
    setActive() {} cancel() {} begin() { return 1; } finish() {} observeReasons() { return {}; } }
  const Chat = load('./Chat.tsx', { react: h.react, 'react/jsx-runtime': jsx, 'react-native': rn,
    '@react-navigation/native': { useFocusEffect() {}, useNavigation: () => ({ isFocused: () => true }) },
    '../lib/api': api, '../lib/companion': protocol, '../lib/companionActions': actions,
    '../lib/insights': { withInsightsDeadline: (work) => work() },
    '../lib/location': { getPosition: async () => options.noLocation ? { ok: false, reason: 'denied' }
      : { ok: true, position: { lat: 1, lon: 2 } } },
    '../lib/haptics': { haptic() {} }, '../lib/notify': { remindAfterPick() {} }, '../lib/otis': { OtisController: Otis },
    '../lib/questionPlan': {}, '../lib/profile': { loadCategories: async () => categories,
      loadTastePrior: async () => ({ favorites: ['chinese'], budget: 2 }), loadCompanionChoices: async () => people },
    '../lib/reasons': { ReasonsCache: Cache }, '../theme': theme,
    './Composer': { __esModule: true, default: 'Composer' }, './Otis': { __esModule: true, default: 'Otis' },
    './ResultCards': { __esModule: true, default: 'Results' }, './ScrollWithBar': { __esModule: true, default: 'Scroll' },
    './TypingBubble': { __esModule: true, default: 'Typing' }, './ui': { Chip: 'Chip', GlassScreen: 'Screen' },
    './CompanionCards': { HistoryCard: 'History', MealReferenceCard: 'Reference', NearbyCard: 'Nearby', PendingCard: 'Pending' },
  }).default;
  const render = () => { h.reset(); tree = Chat({ userId: 'synthetic-user', onSignOut() {}, bottom: 90 }); h.commit(); };
  const flush = async () => { for (let i = 0; i < 6; i++) { await tick(); render(); } };
  render(); await flush();
  return { requests, actions, get tree() { return tree; }, flush,
    send: async (line) => { nodes(tree, 'Composer')[0].props.onSend(line); await flush(); } };
}

test('incomplete logging asks what was eaten and performs zero writes even if Save is invoked', async () => {
  const view = await chat({ interpretations: [{ understood: true, intents: [meal()], patch: {} }] });
  await view.send('Can you log a meal for me?');
  assert.ok(text(view.tree).includes('Sure! What did you eat?'));
  assert.ok(!text(view.tree).includes('Meal saved.'));
  await nodes(view.tree, 'Pending')[0].props.onConfirm(); await view.flush();
  assert.equal(view.requests.filter((r) => /prepare|confirm|cancel/.test(r.path)).length, 0);
});

test('meal follow-up completes the same draft, redacts companions, searches the place and waits for Save', async () => {
  const view = await chat({ interpretations: [
    { understood: true, intents: [meal()], patch: {} },
    { understood: true, intents: [meal({ category: 'chicken_wings', dish: 'nuggets and fries',
      date: { kind: 'today', value: null }, slot: 'lunch', place_name: "McDonald's", company: ['companion_1'] })], patch: {} },
  ] });
  await view.send('Can you log a meal for me?');
  const key = nodes(view.tree, 'Pending')[0].props.pending.key;
  await view.send("Nuggets and fries at McDonald's for lunch today with Synthetic Alex");
  const card = nodes(view.tree, 'Pending')[0];
  assert.equal(card.props.pending.key, key);
  assert.equal(card.props.pending.arguments.category_id, 'chicken_wings');
  assert.equal(card.props.pending.arguments.meal_slot, 'lunch');
  assert.equal(card.props.pending.arguments.place_id, null);
  assert.ok(text(view.tree).includes('No verified match; you can save without a restaurant.'));
  const parses = view.requests.filter((r) => r.path === '/conversation/parse');
  assert.equal(parses.length, 2); assert.equal(parses[1].body.pending_meal, true);
  assert.ok(!parses[1].body.text.includes('Synthetic Alex'));
  assert.equal(view.requests.filter((r) => r.path.startsWith('/places/search?')).length, 1);
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 0);
  await card.props.onConfirm(); await view.flush();
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 1);
  assert.ok(text(view.tree).includes('Meal saved.'));
});

test('food without a date asks when and preserves food through a date-only follow-up', async () => {
  const view = await chat({ interpretations: [
    { understood: true, intents: [meal({ category: 'chicken_wings', dish: 'nuggets' })], patch: {} },
    { understood: true, intents: [meal({ date: { kind: 'yesterday', value: null } })], patch: {} },
  ] });
  await view.send('I ate nuggets'); assert.ok(text(view.tree).includes('When did you eat it?'));
  await view.send('Yesterday');
  const draft = nodes(view.tree, 'Pending')[0].props.pending.arguments;
  assert.equal(draft.category_id, 'chicken_wings'); assert.equal(draft.dish, 'nuggets');
  assert.match(draft.eaten_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 0);
});

for (const options of [{ saveResult: {} }, { saveResult: { status: 'failed' } }, { saveError: true }]) {
  test(`save failure keeps the draft and never reports success: ${JSON.stringify(options)}`, async () => {
    const view = await chat({ ...options, interpretations: [{ understood: true, patch: {}, intents: [meal({
      category: 'chicken_wings', date: { kind: 'iso', value: '2026-11-03' } })] }] });
    await view.send('I had nuggets yesterday');
    await nodes(view.tree, 'Pending')[0].props.onConfirm(); await view.flush();
    assert.equal(nodes(view.tree, 'Pending').length, 1);
    assert.ok(nodes(view.tree, 'Pending')[0].props.error.includes("Couldn't save"));
    assert.ok(!text(view.tree).includes('Meal saved.'));
  });
}

test('Japanese, exact budget and unrestricted distance preserve supported parts and explain prices', async () => {
  const view = await chat({ ready: true, interpretations: [{ understood: true, status: 'unsupported', intents: [{ type: 'survey_patch' }],
    patch: { craving: { status: 'confirmed', value: 'japanese_sushi' },
      distance: { status: 'confirmed', value: 35000 }, unmatched: ['price_range'] } }] });
  await view.send("I want Japanese food that is in the range of $10–$20 and I don't mind how far");
  const request = view.requests.find((r) => r.path === '/conversation/plan');
  assert.equal(request.body.patch.craving.value, 'japanese_sushi');
  assert.equal(request.body.patch.distance.value, 35000);
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').length, 0);
  assert.ok(text(view.tree).includes('exact prices aren’t verified'));
  assert.ok(text(view.tree).includes('Which budget level works'));
});

test('count requests get an honest limit independently of nearby distance', async () => {
  const view = await chat({ ready: true, interpretations: [{ understood: true, intents: [{ type: 'recommend_now' }],
    patch: { distance: { status: 'confirmed', value: 15000 }, unmatched: ['result_count'] } }] });
  await view.send('Show me 2 restaurants nearby please');
  assert.ok(text(view.tree).includes('up to three verified places'));
  assert.equal(view.requests.find((r) => r.path === '/recommendations').body.radius_m, 15000);
});

test('no verified matches offers a supported change instead of claiming three spots', async () => {
  const view = await chat({ ready: true, interpretations: [{ understood: true, intents: [{ type: 'survey_patch' }],
    patch: { craving: { status: 'confirmed', value: 'chinese' }, distance: { status: 'confirmed', value: 35000 } } }] });
  await view.send('I want Chinese and I do not mind the distance');
  assert.ok(text(view.tree).includes('No verified Chinese matches'));
  assert.ok(!text(view.tree).includes('Here are 3 spots'));
  assert.ok(nodes(view.tree, 'Chip').some((n) => n.props.label === 'Something else'));
});

test('one verified match is described as one and a later craving replaces the earlier one', async () => {
  const view = await chat({ ready: true, picks: (body) => [{ id: body.craving === 'chinese' ? 'node/101' : 'node/102',
    name: 'Synthetic restaurant', category: body.craving, reason: 'A nearby spot.', lat: 1, lon: 2, distance_m: 100 }], interpretations: [
    { understood: true, intents: [{ type: 'survey_patch' }], patch: { craving: { status: 'confirmed', value: 'chinese' } } },
    { understood: true, intents: [{ type: 'survey_patch' }], patch: { craving: { status: 'confirmed', value: 'mexican' } } },
  ] });
  await view.send('I want Chinese');
  assert.ok(text(view.tree).includes('Found 1 verified Chinese match.'));
  await view.send('What about Mexican?');
  const rounds = view.requests.filter((r) => r.path === '/recommendations');
  assert.equal(rounds.length, 2); assert.equal(rounds[1].body.craving, 'mexican');
  assert.equal(rounds[1].body.survey.craving.status, 'confirmed');
});

test('a dish limitation does not trigger unrelated recommendations', async () => {
  const view = await chat({ ready: true, interpretations: [{ understood: true, intents: [{ type: 'recommend_now' }],
    patch: { unmatched: ['menu'] } }] });
  await view.send('Show me places with nuggets');
  assert.ok(text(view.tree).includes('can’t verify menu items'));
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').length, 0);
});

test('missing location preserves the meal and explains the food-only alternative', async () => {
  const view = await chat({ noLocation: true, interpretations: [{ understood: true, patch: {}, intents: [meal({
    category: 'chicken_wings', date: { kind: 'today', value: null }, place_name: 'Synthetic restaurant' })] }] });
  await view.send('I ate wings at Synthetic restaurant today');
  assert.ok(text(view.tree).includes('Location is unavailable'));
  assert.equal(nodes(view.tree, 'Pending')[0].props.pending.arguments.place_id, null);
  assert.equal(view.requests.filter((r) => r.path.startsWith('/places/search?')).length, 0);
});

test('parse failure copy distinguishes timeout, truncation, invalid JSON and ambiguity', () => {
  const lines = ['timeout', 'truncated', 'invalid_json', 'unavailable', 'ambiguous']
    .map((status) => protocol.parseFailureLine({ status }));
  assert.equal(new Set(lines).size, 5);
  assert.ok(lines.every((line) => !line.includes("Didn't catch")));
});

test('reason loading copy describes an optional check without promising a replacement', async () => {
  const view = await chat({ thinking: true });
  assert.ok(text(view.tree).includes('Checking optional reasons…'));
  assert.ok(!text(view.tree).includes('Finishing reasons'));
});

test('compact confirmation exposes food category, Save and Edit; full editor opens only through Edit', () => {
  const h = hooks(); let saved = 0; let tree;
  let pending = { key: 'synthetic', kind: 'log_meal', arguments: {
    category_id: 'chicken_wings', dish: 'nuggets and fries', eaten_on: '2026-11-03', timezone: 'America/New_York',
    meal_slot: 'lunch', place_id: null, companion_ids: [], solo: null, stars: null, allow_duplicate: false } };
  const { PendingCard } = load('./CompanionCards.tsx', { react: h.react, 'react/jsx-runtime': jsx, 'react-native': rn,
    '../lib/companion': protocol, '../lib/insights': {}, '../lib/places': {}, '../theme': theme,
    './charts/InsightCharts': {}, './charts/OpeningMotion': {}, './PlaceMap': { Attribution: 'Attribution' },
    './ui': { Chip: 'Chip', GlassCard: 'Card', PrimaryButton: 'Primary', SecondaryButton: 'Secondary' } });
  function render() { h.reset(); tree = PendingCard({ pending, categories, people, busy: false, error: null,
    duplicate: false, onChange: (value) => { pending = value; }, onConfirm: () => { saved++; },
    onCancel() {}, onWhere() {} }); }
  render();
  assert.equal(nodes(tree, 'Input').length, 0);
  assert.ok(text(tree).includes('Chicken/Wings') && text(tree).includes('Without a restaurant'));
  assert.equal(nodes(tree, 'Primary')[0].props.label, 'Save'); assert.equal(saved, 0);
  nodes(tree, 'Chip').find((n) => n.props.label === 'Edit').props.onPress(); render();
  assert.ok(nodes(tree, 'Input').length > 0);
  nodes(tree, 'Input').find((n) => n.props.accessibilityLabel === 'Dish').props.onChangeText('wings'); render();
  assert.equal(pending.arguments.dish, 'wings'); assert.equal(saved, 0);
  nodes(tree, 'Primary')[0].props.onPress(); assert.equal(saved, 1);
});
