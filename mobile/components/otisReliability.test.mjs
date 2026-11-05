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
function nodes(tree, type, includeHidden = false) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, type, includeHidden));
  if (!includeHidden && tree.props?.hidden) return [];
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type, includeHidden)];
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

async function chat(options = {}) {
  const h = hooks(); let tree; let turn = 0;
  const requests = [];
  class ApiError extends Error { constructor(kind, code) { super(kind); this.kind = kind; this.code = code; } }
  const api = { ApiError, localTimeIso: () => '2026-11-04T19:00:00-05:00', deviceTimezone: () => 'America/New_York',
    companionCall: async (path, body) => {
      requests.push({ path, body });
      if (path === '/conversation/parse') return typeof options.interpretations === 'function' ? options.interpretations(turn++) : options.interpretations[turn++];
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
      if (options.searchError) throw new ApiError('server', options.searchError);
      if (options.recommendations) return options.recommendations(body);
      return { session_id: 'synthetic-session', round: 1, logged: true, best_so_far: false,
        answers: { craving: body.craving, budget_level: body.budget_level, radius_m: body.radius_m, exclude_categories: [] },
        required_craving: body.craving, search_status: options.searchStatus ?? 'complete',
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

const social = (reply) => ({ understood: true, intents: [{ type: 'unknown' }], patch: {}, reply });
const search = (craving) => ({ understood: true, intents: [{ type: 'recommend_now' }],
  patch: { craving: { status: 'confirmed', value: craving } } });
const pick = (category) => ({ id: `synthetic-${category}`, name: `Synthetic ${category}`,
  category, lat: 1, lon: 2, distance_m: 100, reason: 'Nearby.' });

test('new Eat chat uses the exact approved Otis introduction with zero network calls', async () => {
  const view = await chat();
  assert.ok(text(view.tree).includes("Hey, I'm Otis! I'll help you find food that fits your taste. What sounds good?"));
  assert.deepEqual(view.requests, []);
});

test('greeting and conversational follow-up display Muse replies without starting the survey', async () => {
  const view = await chat({ interpretations: [
    social("I'm here and ready to help! What sounds good to eat?"),
    social("I don't eat, but I can help you choose something tasty!"),
  ] });
  await view.send('Hello! How are you doing?');
  assert.ok(text(view.tree).includes("I'm here and ready to help!"));
  await view.send('What about you?');
  assert.ok(text(view.tree).includes("I don't eat, but I can help you choose"));
  assert.equal(view.requests.length, 2);
  const second = view.requests[1].body;
  assert.ok(second.recent_context.some((line) => line.content === 'Hello! How are you doing?'));
  assert.ok(second.recent_context.some((line) => line.content.includes("I'm here and ready")));
  assert.ok(!text(view.tree).includes('Are you looking for food, or logging a meal?'));
  assert.ok(!text(view.tree).includes('Budget this time?'));
});

test('recent conversation is bounded and companion names are redacted on every turn', async () => {
  const view = await chat({ interpretations: () => social('I can help you find food.') });
  for (let i = 0; i < 7; i++) await view.send(`Hello from Synthetic Alex ${i}`);
  for (const request of view.requests) {
    assert.equal(request.path, '/conversation/parse');
    assert.ok(!JSON.stringify(request.body).includes('Synthetic Alex'));
    assert.ok(request.body.recent_context.length <= 6);
  }
  assert.equal(view.requests.at(-1).body.recent_context.length, 6);
  assert.ok(view.requests.at(-1).body.recent_context.some((line) => line.content.includes('companion_1')));
});

test('capability reply is shown and an unsupported exact-price request uses truthful code wording', async () => {
  const line = 'I can find food, help log meals, and show your history.';
  const view = await chat({ interpretations: [social(line), { understood: true, intents: [],
    patch: { unmatched: ['price_range'], budget: { status: 'uncertain', value: null } } }] });
  await view.send('What can you do?');
  assert.ok(text(view.tree).includes(line));
  await view.send('Find dinner for exactly twelve dollars');
  assert.ok(text(view.tree).includes('exact prices aren’t verified'));
  assert.ok(text(view.tree).includes('Which budget level works: $ to $$$$?'));
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').length, 0);
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 2);
});

test('changing and clearing cravings removes stale cards and requests fresh cap eligibility', async () => {
  const view = await chat({ ready: true, interpretations: [search('mexican'), search('japanese_sushi'), search(null)],
    picks: (body) => [pick(body.craving ?? 'chinese')] });
  await view.send('Can you find Mexican food?');
  assert.equal(nodes(view.tree, 'Results').length, 1);
  assert.equal(nodes(view.tree, 'Results')[0].props.picks[0].category, 'mexican');
  await view.send('Actually Japanese');
  let cards = nodes(view.tree, 'Results');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.picks[0].category, 'japanese_sushi');
  const obsolete = nodes(view.tree, 'Results', true).filter((node) => node.props.hidden);
  assert.equal(obsolete.length, 1);
  assert.equal(obsolete[0].props.picks[0].category, 'mexican');
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').at(-1).body.requirements_changed, true);
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').at(-1).body.active_craving, 'mexican');
  await view.send('Anything is fine');
  cards = nodes(view.tree, 'Results');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.picks[0].category, 'chinese');
  const last = view.requests.filter((r) => r.path === '/recommendations').at(-1).body;
  assert.equal(last.survey.craving.value, null);
  assert.equal(last.requirements_changed, true);
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 3);
});

test('social dialogue between recommendation actions leaves the current cards selectable', async () => {
  const view = await chat({ ready: true, interpretations: [search('chinese'), social('Happy to help you choose!')],
    picks: [pick('chinese')] });
  await view.send('Find Chinese food');
  await view.send('Thanks, how are you?');
  const cards = nodes(view.tree, 'Results');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.readOnly, false);
  assert.equal(typeof cards[0].props.onDecisionStart(), 'function');
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').length, 1);
});

test('Something else chip preserves the active explicit requirement and makes zero parse calls', async () => {
  const view = await chat({ ready: true, interpretations: [search('japanese_sushi')], picks: [pick('japanese_sushi')] });
  await view.send('Find Japanese food');
  nodes(view.tree, 'Results')[0].props.onNoneOfThese();
  await view.flush();
  nodes(view.tree, 'Chip').find((node) => node.props.label === 'Something else').props.onPress();
  await view.flush();
  const calls = view.requests.filter((r) => r.path === '/recommendations');
  assert.equal(calls.at(-1).body.survey.craving.value, 'japanese_sushi');
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 1);
});

test('empty matches, failed widening, incomplete search and cached-only results have distinct honest copy', async () => {
  const lines = [];
  for (const searchStatus of ['complete', 'timeout', 'provider_error', 'incomplete', 'cached', 'unsupported_category']) {
    const view = await chat({ ready: true, interpretations: [search('japanese_sushi')], searchStatus });
    await view.send('Find Japanese food');
    const content = text(view.tree);
    const expected = { complete: 'No verified Japanese/Sushi matches', timeout: 'wider search timed out',
      provider_error: 'wider search failed', incomplete: 'search was incomplete', cached: 'No earlier picks fit',
      unsupported_category: 'can’t verify that food category' };
    assert.ok(content.includes(expected[searchStatus]), content);
    assert.equal(nodes(view.tree, 'Results').length, 0);
    lines.push(content);
  }
  assert.equal(new Set(lines).size, 6);
});

test('initial provider timeout and provider failure do not say no restaurants exist', async () => {
  for (const code of ['places_timeout', 'places_unavailable']) {
    const view = await chat({ ready: true, interpretations: [search('chinese')], searchError: code });
    await view.send('Find Chinese food');
    const content = text(view.tree);
    assert.ok(content.includes(code === 'places_timeout' ? 'restaurant search timed out' : 'Restaurant search is unavailable'));
    assert.ok(!content.includes('No verified'));
    assert.equal(nodes(view.tree, 'Results').length, 0);
  }
});

test('obsolete cards render nothing while an in-flight legitimate pick retains its feedback reminder', async () => {
  const h = hooks();
  let complete;
  const saved = new Promise((resolve) => { complete = resolve; });
  let current = true;
  const reminders = [], lines = [];
  const Cards = load('./ResultCards.tsx', { react: h.react, 'react/jsx-runtime': jsx,
    'react-native': rn, '../theme': theme, '../lib/accessibility': {}, '../lib/haptics': { haptic() {} },
    '../lib/api': { logPicked: () => saved, logInterested: async () => {} },
    '../lib/places': {}, '../lib/reasons': {}, './PlaceMap': { MiniMap: 'Map', Attribution: 'Attribution' },
    './PressScale': { __esModule: true, default: 'Press' }, './ui': { Chip: 'Chip', GlassCard: 'Card' },
  }).default;
  const props = { picks: [pick('mexican')], userId: 'synthetic-user', user: null,
    reasonsCache: { isCurrent: () => true }, generation: 0, sessionId: 'synthetic-session', round: 1,
    onDecisionStart: () => () => current, onSay: (line) => lines.push(line),
    onPicked: () => reminders.push('synthetic-user') };
  const render = (extra = {}) => { h.reset(); const tree = Cards({ ...props, ...extra }); h.commit(); return tree; };
  const tree = render();
  nodes(tree, 'Chip').find((node) => node.props.label === 'Pick this').props.onPress();
  current = false;
  assert.equal(render({ hidden: true, readOnly: true }), null);
  complete({ logged: true });
  await tick();
  assert.deepEqual(reminders, ['synthetic-user']);
  assert.deepEqual(lines, []);
});

