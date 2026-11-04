import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import * as protocol from '../lib/companion.ts';

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
  if (tree == null || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function text(tree) {
  if (typeof tree === 'string') return tree;
  if (!tree || typeof tree !== 'object') return '';
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return text(tree.props?.children);
}
const complete = () => {
  const state = protocol.emptySurvey();
  for (const [key, value] of Object.entries({ craving: 'chinese', budget: 1, distance: 15000 })) {
    state[key] = { value, status: 'confirmed', source: 'typed', turn: 1 };
  }
  return state;
};
const categories = [{ id: 'chinese', name: 'Chinese' }, { id: 'italian', name: 'Italian' }, { id: 'chicken_wings', name: 'Chicken/Wings' }];

async function chat({ interpretation, ready = false, next = 'budget', withPick = false, confirm, loadPeople } = {}) {
  const slots = []; let cursor = 0; let effects = []; let tree;
  const state = (initial) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const react = {
    Fragment: 'Fragment', useState: state, useRef: (initial) => state(() => ({ current: initial }))[0],
    useCallback: (fn) => fn, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: (fn, deps) => {
      const index = cursor++; const previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; effects.push(fn); }
    },
  };
  const requests = [];
  class ApiError extends Error {}
  const api = { ApiError, localTimeIso: () => '2026-11-04T19:00:00-05:00', deviceTimezone: () => 'America/New_York',
    companionCall: async (path, body) => {
      requests.push({ path, body });
      if (path === '/conversation/parse') return typeof interpretation === 'function' ? interpretation() : interpretation;
      if (path === '/conversation/context') return { conversation_id: '00000000-0000-0000-0000-000000000075' };
      if (path === '/conversation/plan') return { state: ready ? complete() : body.state, next_key: ready ? null : next,
        ready, conversation_id: '00000000-0000-0000-0000-000000000075' };
      if (path === '/conversation/history') return { from_date: '2026-10-29', to_date: '2026-11-04',
        chart_id: 'top', line: '0 recorded meals.', note: null, stats: { complete: true,
          cutoff_date: '2026-11-04', summary: { meal_count: 0, category_meal_count: 0 },
          companions: { companions: [], with_company_meal_count: 0,
            coverage: { unlinked_meals: 0, contradictory_company_meals: 0 } },
          price_by_slot: [], food_by_slot: [], distance_by_slot: [], top_categories: [],
          coverage: { unknown_slot_meals: 0, missing_price_meals: 0,
            backfill_distance_meals: 0, missing_distance_meals: 0 } } };
      if (path.endsWith('/prepare')) return { id: '00000000-0000-0000-0000-000000000077', state: 'pending', arguments: body.arguments };
      if (path.endsWith('/confirm')) return confirm ? confirm(body) : { status: 'saved' };
      if (path.endsWith('/cancel')) return { cancelled: true };
      throw new Error(`Unexpected request ${path}`);
    },
    getRecommendations: async (body) => {
      requests.push({ path: '/recommendations', body });
      return { session_id: '00000000-0000-0000-0000-000000000076', round: 1, logged: true, best_so_far: false, reasons_envelope: { payload: '{}', signature: 'a'.repeat(64) },
        answers: { craving: 'chinese', budget_level: 1, radius_m: 15000, exclude_categories: [] },
        next_question: { key: 'budget', options: [1, 2], gains: {} },
        picks: withPick ? [{ id: 'node/75', name: 'Synthetic place', category: 'chinese', distance_m: 10, lat: 1, lon: 2 }] : [] };
    },
  };
  const actions = load('../lib/companionActions.ts', { '../lib/api': api, './api': api, './companion': protocol });
  class Cache { generation = 0; clear() {} invalidate() { this.generation++; } current() { return this.generation; } isCurrent(g) { return g === this.generation; } }
  class Otis { subscribe() {} getSnapshot() { return { active: true, state: 'idle' }; }
    setActive() {} cancel() {} begin() { return 1; } finish() {} observeReasons() { return {}; } }
  const rn = { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} }, Linking: {},
    StyleSheet: { create: (styles) => styles }, ActivityIndicator: 'Spinner', KeyboardAvoidingView: 'Avoid',
    Pressable: 'Pressable', Text: 'Text', View: 'View' };
  const theme = load('../theme.ts', {});
  const deps = { react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': rn, '@react-navigation/native': { useFocusEffect() {}, useNavigation: () => ({ isFocused: () => true }) },
    '../lib/api': api, '../lib/companion': protocol, '../lib/companionActions': actions,
    '../lib/insights': { withInsightsDeadline: (work) => work() }, '../lib/location': { getPosition: async () => ({ ok: true, position: { lat: 1, lon: 2 } }) },
    '../lib/haptics': { haptic() {} }, '../lib/notify': { remindAfterPick() {} }, '../lib/otis': { OtisController: Otis },
    '../lib/questionPlan': { budgetPick: (preset, prior) => preset.budget ?? prior, traceOf: () => ({}) },
    '../lib/profile': { loadCategories: async () => categories, loadTastePrior: async () => ({ favorites: ['chinese'], budget: 2 }),
      loadCompanionChoices: loadPeople ?? (async () => [{ id: '00000000-0000-0000-0000-000000000079', name: 'Synthetic Alex' }]) },
    '../lib/reasons': { ReasonsCache: Cache }, '../theme': theme,
    './Composer': { __esModule: true, default: 'Composer' }, './Otis': { __esModule: true, default: 'Otis' }, './ResultCards': { __esModule: true, default: 'Results' },
    './ScrollWithBar': { __esModule: true, default: 'Scroll' }, './TypingBubble': { __esModule: true, default: 'Typing' },
    './ui': { Chip: 'Chip', GlassScreen: 'Screen' }, './CompanionCards': { HistoryCard: 'History', MealReferenceCard: 'Reference', NearbyCard: 'Nearby', PendingCard: 'Pending' },
  };
  const Chat = load('./Chat.tsx', deps).default;
  const render = () => { cursor = 0; effects = []; tree = Chat({ userId: '00000000-0000-0000-0000-000000000078', onSignOut() {}, bottom: 10 }); const run = effects; run.forEach((effect) => effect()); return tree; };
  const flush = async () => { await new Promise(setImmediate); render(); };
  render(); await flush();
  return { requests, flush, get tree() { return tree; }, send: async (line) => { nodes(tree, 'Composer')[0].props.onSend(line); await flush(); } };
}

test('Eat opens with fixed greeting and no Muse or question-plan call', async () => {
  const view = await chat();
  assert.ok(text(view.tree).includes('Hey! What are we eating today?'));
  assert.equal(view.requests.length, 0);
});
test('multi-field first message renders no repeated questions and makes one redacted parse call', async () => {
  const view = await chat({ ready: true, withPick: true, interpretation: { understood: true,
    intents: [{ type: 'survey_patch' }], patch: {
      craving: { status: 'confirmed', value: 'chinese' }, budget: { status: 'confirmed', value: 1 }, distance: { status: 'confirmed', value: 15000 } } } });
  await view.send('Chinese, cheap, close, with Synthetic Alex');
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 1);
  assert.ok(!view.requests[0].body.text.includes('Synthetic Alex'));
  assert.equal(view.requests.filter((r) => r.path === '/recommendations').length, 1);
  assert.ok(nodes(view.tree, 'Results')[0].props.envelope);
  assert.ok(!text(view.tree).includes('Budget this time?'));
});
test('deterministic survey chip taps never call Muse parsing', async () => {
  const view = await chat();
  nodes(view.tree, 'Chip').find((n) => n.props.label === 'Chinese').props.onPress(); await view.flush();
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 0);
  assert.equal(view.requests[0].body.source, 'chip');
  assert.deepEqual(view.requests[0].body.patch.craving, { status: 'confirmed', value: 'chinese' });
});
test('first None of these shows the approved invitation and keeps deterministic refinement chips', async () => {
  const view = await chat({ ready: true, withPick: true,
    interpretation: { understood: true, intents: [{ type: 'recommend_now' }], patch: {} } });
  await view.send('Show picks now');
  nodes(view.tree, 'Results')[0].props.onNoneOfThese(); await view.flush();
  assert.ok(text(view.tree).includes('I see, any clue what you may want?'));
  assert.ok(nodes(view.tree, 'Chip').some((n) => n.props.label === '$'));
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 1);
});
test('meal intent freezes survey and saves only after one explicit Confirm despite a double tap', async () => {
  let finish; const saving = new Promise((resolve) => { finish = resolve; });
  const view = await chat({ confirm: () => saving, interpretation: { understood: true, patch: {}, intents: [{ type: 'log_meal',
    category: 'chicken_wings', dish: null, date: { kind: 'iso', value: '2026-11-03' }, slot: null,
    place_name: null, company: [], solo: null, stars: null }] } });
  await view.send('I had wings yesterday');
  const card = nodes(view.tree, 'Pending')[0];
  assert.ok(card); assert.ok(!text(view.tree).includes('Budget this time?'));
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 0);
  const first = card.props.onConfirm(); const second = card.props.onConfirm(); await view.flush();
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 1);
  finish({ status: 'saved' }); await first; await second; await view.flush();
  assert.equal(nodes(view.tree, 'Pending').length, 0);
  assert.ok(text(view.tree).includes('Meal saved.'));
});


test('a failed companion read never uploads an unredacted free-text message', async () => {
  const view = await chat({ loadPeople: async () => { throw new Error('Synthetic unavailable'); } });
  assert.ok(nodes(view.tree, 'Chip').some((n) => n.props.label === 'Chinese'));
  await view.send('Chinese with Synthetic Alex');
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 0);
  assert.ok(text(view.tree).includes("Couldn't finish that"));
});

test('two side effects expose only the first until explicit confirmation and another user tap', async () => {
  const view = await chat({ interpretation: { understood: true, patch: {}, intents: [
    { type: 'log_meal', category: 'chicken_wings', dish: null, date: { kind: 'iso', value: '2026-11-03' },
      slot: null, place_name: null, company: [], solo: null, stars: null },
    { type: 'preference_change', operation: 'remove_favorite', category: 'chinese' },
  ] } });
  await view.send('Log wings yesterday and remove Chinese from favorites');
  assert.equal(nodes(view.tree, 'Pending').length, 1);
  assert.equal(nodes(view.tree, 'Pending')[0].props.pending.kind, 'log_meal');
  assert.equal(view.requests.filter((r) => r.path.endsWith('/prepare')).length, 0);
  await nodes(view.tree, 'Pending')[0].props.onConfirm(); await view.flush();
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 1);
  assert.ok(nodes(view.tree, 'Chip').some((n) => n.props.label === 'Handle the other action'));
  assert.equal(view.requests.filter((r) => r.path === '/conversation/profile').length, 0);
});

test('an unrelated parsed message cancels the pending meal without saving it', async () => {
  let turn = 0;
  const view = await chat({ interpretation: () => ++turn === 1 ? { understood: true, patch: {}, intents: [
    { type: 'log_meal', category: 'chicken_wings', dish: null, date: { kind: 'iso', value: '2026-11-03' },
      slot: null, place_name: null, company: [], solo: null, stars: null },
  ] } : { understood: true, patch: { budget: { status: 'confirmed', value: 1 } }, intents: [{ type: 'survey_patch' }] } });
  await view.send('I had wings yesterday');
  await view.send('Something cheap today');
  assert.equal(nodes(view.tree, 'Pending').length, 0);
  assert.ok(text(view.tree).includes('Cancelled that action.'));
  assert.equal(view.requests.filter((r) => r.path.endsWith('/cancel')).length, 0); // Still local: no preparation or write occurred.
  assert.equal(view.requests.filter((r) => r.path.endsWith('/confirm')).length, 0);
});


test('a chip-generated round keeps templates and never schedules Muse reason enhancement', async () => {
  const view = await chat({ ready: true, withPick: true });
  nodes(view.tree, 'Chip').find((n) => n.props.label === 'Chinese').props.onPress(); await view.flush();
  assert.equal(nodes(view.tree, 'Results')[0].props.envelope, null);
  assert.equal(view.requests.filter((r) => r.path === '/conversation/parse').length, 0);
});


test('verified history stays at its own turn and a pure read does not recompute the survey', async () => {
  let turn = 0;
  const view = await chat({ interpretation: () => ++turn === 1 ? { understood: true, patch: {}, intents: [
    { type: 'history_query', range: 'last_7_days', chart_id: 'top', slot: null },
  ] } : { understood: true, patch: { budget: { status: 'confirmed', value: 1 } }, intents: [{ type: 'survey_patch' }] } });
  await view.send('Show my food chart');
  assert.equal(view.requests.filter((r) => r.path === '/conversation/plan').length, 0);
  const history = nodes(view.tree, 'History')[0];
  assert.equal(history.props.data.stats.summary.meal_count, 0);
  await view.send('Something cheap today');
  const timeline = [nodes(view.tree, 'Scroll')[0].props.children].flat(Infinity).filter((n) => n && typeof n === 'object');
  const historyIndex = timeline.findIndex((n) => n.type === 'History');
  const nextMessageIndex = timeline.findIndex((n) => text(n).includes('Something cheap today'));
  assert.ok(historyIndex >= 0 && nextMessageIndex > historyIndex);
});
