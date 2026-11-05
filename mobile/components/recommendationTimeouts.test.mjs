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
const categories = [{ id: 'pizza', name: 'Pizza' }, { id: 'chinese', name: 'Chinese' }, { id: 'mexican', name: 'Mexican' },
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


const search = (craving = 'pizza') => ({ understood: true, intents: [{ type: 'recommend_now' }],
  patch: { craving: { status: 'confirmed', value: craving } } });
const requests = (view) => view.requests.filter((r) => r.path === '/recommendations');
const timeoutCount = (view) => (text(view.tree).match(/The restaurant search timed out on that attempt; please retry\./g) ?? []).length;
const retry = (view) => nodes(view.tree, 'Chip').find((n) => n.props.label === 'Try again').props.onPress;
const result = (body, changes = {}) => ({ session_id: '00000000-0000-0000-0000-000000000071',
  round: 1, logged: true, best_so_far: false, search_status: 'complete', picks: [], next_question: null,
  answers: { craving: body.craving, budget_level: body.budget_level, radius_m: body.radius_m, exclude_categories: [] },
  ...changes });

test('timeouts are retried only by explicit taps and identical consecutive errors are shown once', async () => {
  const view = await chat({ ready: true, interpretations: [search()], searchError: 'places_timeout' });
  await view.send('Find pizza');
  assert.equal(requests(view).length, 1);
  assert.equal(requests(view)[0].body.request_source, 'typed');
  assert.equal(timeoutCount(view), 1);
  await view.flush();
  assert.equal(requests(view).length, 1); // no timer, effect or automatic retry
  retry(view)(); await view.flush();
  retry(view)(); await view.flush();
  assert.equal(requests(view).length, 3); // one initial attempt and two manual taps
  assert.deepEqual(requests(view).map((r) => r.body.request_source), ['typed', 'retry', 'retry']);
  assert.equal(timeoutCount(view), 1);
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 1);
  assert.ok(nodes(view.tree, 'Chip').some((n) => n.props.label === 'Try again'));
});

test('two rapid presses of the same retry handler share one in-flight recommendation attempt', async () => {
  let complete;
  const waiting = new Promise((resolve) => { complete = resolve; });
  const options = { ready: true, interpretations: [search()], searchError: 'places_timeout' };
  const view = await chat(options);
  await view.send('Find pizza');
  options.searchError = null;
  options.recommendations = (body) => waiting.then(() => result(body));
  const staleRetry = retry(view);
  staleRetry(); staleRetry(); staleRetry();
  await view.flush();
  assert.equal(requests(view).length, 2);
  assert.equal(requests(view)[1].body.request_source, 'retry');
  assert.equal(timeoutCount(view), 1);
  complete(); await view.flush();
  assert.ok(!nodes(view.tree, 'Chip').some((n) => n.props.label === 'Try again'));
});

test('a changed error or intervening user request gets a fresh truthful response', async () => {
  const options = { ready: true, interpretations: [search(), search('chinese')], searchError: 'places_timeout' };
  const view = await chat(options);
  await view.send('Find pizza');
  options.searchError = 'places_unavailable';
  retry(view)(); await view.flush();
  assert.ok(text(view.tree).includes('Restaurant search is unavailable; please retry.'));
  options.searchError = 'places_timeout';
  await view.send('Actually Chinese');
  assert.equal(timeoutCount(view), 2);
  assert.deepEqual(requests(view).map((r) => r.body.request_source), ['typed', 'retry', 'typed']);
  assert.equal(requests(view).at(-1).body.survey.craving.value, 'chinese');
});

test('eligible partial pizza results display cards and coverage wording without a total failure', async () => {
  const view = await chat({ ready: true, interpretations: [search()], recommendations: (body) => result(body, {
    required_craving: 'pizza', search_status: 'partial', search_issue: 'timeout',
    picks: [{ id: 'node/73001', name: 'Synthetic Pizza', category: 'pizza',
      lat: 1, lon: 2, distance_m: 100, reason: 'Matches your Pizza craving.' }],
  }) });
  await view.send('Find pizza');
  assert.equal(requests(view).length, 1);
  assert.equal(nodes(view.tree, 'Results').length, 1);
  assert.ok(text(view.tree).includes('Found 1 eligible place; wider search timed out.'));
  assert.equal(timeoutCount(view), 0);
  assert.ok(!nodes(view.tree, 'Chip').some((n) => n.props.label === 'Try again'));
});

test('a location failure releases the recommendation guard for an explicit successful retry', async () => {
  const options = { ready: true, interpretations: [search()], noLocation: true };
  const view = await chat(options);
  await view.send('Find pizza');
  assert.equal(requests(view).length, 0);
  options.noLocation = false;
  retry(view)(); await view.flush();
  assert.equal(requests(view).length, 1);
  assert.equal(requests(view)[0].body.request_source, 'retry');
});

