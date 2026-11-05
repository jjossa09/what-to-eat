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

const NOW = new Date(2026, 10, 4, 12);
const theme = load('../theme.ts', {});
function cards(h) {
  return load('./CompanionCards.tsx', { react: h.react, 'react/jsx-runtime': jsx,
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'Input',
      StyleSheet: { create: (styles) => styles } }, '../lib/companion': protocol,
    '../lib/insights': {}, '../lib/places': {}, '../theme': theme,
    './charts/InsightCharts': {}, './charts/OpeningMotion': {}, './PlaceMap': {},
    './ui': { Chip: 'Chip', GlassCard: 'Card', PrimaryButton: 'Save', SecondaryButton: 'Cancel' },
  });
}
const meal = (changes = {}) => ({ type: 'log_meal', category: null, date: null, slot: null,
  dish: null, place_name: null, company: [], solo: null, stars: null, ...changes });

function actions() {
  const calls = [];
  const exported = load('../lib/companionActions.ts', { './companion': protocol,
    './api': { deviceTimezone: () => 'America/New_York', companionCall: async (path, body) => {
      calls.push({ path, body });
      return path.endsWith('/prepare') ? { id: '00000000-0000-0000-0000-000000000077', arguments: body.arguments }
        : { status: 'saved', meal_id: '00000000-0000-0000-0000-000000000080' };
    } } });
  return { ...exported, calls };
}

test('yesterday is November 3 on the November 4 local calendar and crosses month/year boundaries', () => {
  assert.equal(protocol.resolveDate({ kind: 'yesterday', value: null }, NOW), '2026-11-03');
  assert.equal(protocol.resolveDate({ kind: 'yesterday', value: null }, new Date(2026, 2, 1, 12)), '2026-02-28');
  assert.equal(protocol.resolveDate({ kind: 'yesterday', value: null }, new Date(2026, 0, 1, 12)), '2025-12-31');
  const utcBoundary = new Date('2026-11-05T02:30:00Z');
  assert.equal(protocol.calendarDate(utcBoundary), '2026-11-04'); // command fixes TZ to New York
  assert.equal(protocol.resolveDate({ kind: 'yesterday', value: null }, utcBoundary), '2026-11-03');
});

test('invalid calendar dates, future dates and unresolved weekdays never become a valid ISO date', () => {
  for (const value of ['2026-11-05', '2026-02-30', '2026-13-01', 'not a date']) {
    assert.equal(protocol.resolveDate({ kind: 'iso', value }, NOW), null);
    assert.equal(protocol.validMealDate(value, NOW), false);
  }
  assert.equal(protocol.resolveDate({ kind: 'weekday', value: 'tuesday' }, NOW), null);
  assert.equal(protocol.resolveDate({ kind: 'last_weekday', value: 'tuesday' }, NOW), null);
  assert.equal(protocol.displayMealDate('2026-11-03'), 'Nov 3, 2026');
});

test('Today and Yesterday shortcuts use native controls and return ISO without a text field', () => {
  const h = hooks(); const { MealDatePicker } = cards(h); const picked = [];
  const render = () => { h.reset(); const tree = MealDatePicker({ value: '', now: NOW,
    onChange: (iso) => picked.push(iso) }); h.commit(); return tree; };
  let tree = render();
  assert.equal(nodes(tree, 'Input').length, 0);
  nodes(tree, 'Chip').find((node) => node.props.label === 'Today').props.onPress();
  tree = render();
  nodes(tree, 'Chip').find((node) => node.props.label === 'Yesterday').props.onPress();
  assert.deepEqual(picked, ['2026-11-04', '2026-11-03']);
});

test('calendar navigation selects an older day, exposes readable accessibility labels and blocks future days', () => {
  const h = hooks(); const { MealDatePicker } = cards(h); const picked = [];
  const render = () => { h.reset(); const tree = MealDatePicker({ value: '', now: NOW,
    onChange: (iso) => picked.push(iso) }); h.commit(); return tree; };
  let tree = render();
  nodes(tree, 'Chip').find((node) => node.props.label === 'Choose date').props.onPress();
  tree = render();
  const future = nodes(tree, 'Pressable').find((node) => node.props.accessibilityLabel === 'Nov 5, 2026');
  assert.equal(future.props.disabled, true);
  future.props.onPress(); assert.deepEqual(picked, []);
  assert.equal(nodes(tree, 'Pressable').find((node) => node.props.accessibilityLabel === 'Next month').props.disabled, true);
  nodes(tree, 'Pressable').find((node) => node.props.accessibilityLabel === 'Previous month').props.onPress();
  tree = render();
  assert.ok(text(tree).includes('October 2026'));
  const older = nodes(tree, 'Pressable').find((node) => node.props.accessibilityLabel === 'Oct 31, 2026');
  assert.equal(older.props.accessibilityState.disabled, false);
  older.props.onPress();
  assert.deepEqual(picked, ['2026-10-31']);
  assert.ok(!text(render()).includes('October 2026')); // selection closes the calendar
});

test('pending meal follow-ups retain confirmed dates and company while omitted fields remain unknown', () => {
  const api = actions();
  const people = [{ id: '00000000-0000-0000-0000-000000000079', name: 'Synthetic Jessica' }];
  const original = { key: 'synthetic', kind: 'log_meal', arguments: api.draftMeal(meal({
    category: 'chinese', date: { kind: 'iso', value: '2026-11-03' } }), people) };
  assert.deepEqual(original.arguments.companion_ids, []);
  assert.equal(original.arguments.solo, null);
  const next = api.enrichMeal(original, meal({ slot: 'dinner' }), people);
  assert.equal(next.arguments.eaten_on, '2026-11-03');
  assert.deepEqual(next.arguments.companion_ids, []);
  const explicit = api.enrichMeal(next, meal({ company: ['companion_1'], solo: false }), people);
  assert.deepEqual(explicit.arguments.companion_ids, ['00000000-0000-0000-0000-000000000079']);
  const retained = api.enrichMeal(explicit, meal({ dish: 'Synthetic dish' }), people);
  assert.deepEqual(retained.arguments.companion_ids, ['00000000-0000-0000-0000-000000000079']);
  assert.equal(retained.arguments.eaten_on, '2026-11-03');
  const solo = api.enrichMeal(retained, meal({ solo: true }), people);
  assert.deepEqual(solo.arguments.companion_ids, []);
});

test('calendar selection reaches the confirmed action as exact ISO and never saves just by selecting', async () => {
  const api = actions(), h = hooks(); const { PendingCard, MealDatePicker } = cards(h);
  let pending = { key: 'synthetic', kind: 'log_meal', arguments: {
    category_id: 'chinese', eaten_on: '', timezone: 'America/New_York', meal_slot: 'dinner',
    dish: '', place_id: null, companion_ids: [], solo: null, stars: null, allow_duplicate: false,
  } };
  let saving;
  const render = () => { h.reset(); const tree = PendingCard({ pending, categories: [{ id: 'chinese', name: 'Chinese' }],
    people: [{ id: '00000000-0000-0000-0000-000000000079', name: 'Synthetic Jessica' }], busy: false, error: null, duplicate: false,
    onChange: (next) => { pending = next; }, onCancel() {}, onWhere() {},
    onConfirm: () => { saving = api.persistPending(pending, '00000000-0000-0000-0000-000000000075').then((prepared) => prepared.save()); },
  }); h.commit(); return tree; };
  let tree = render();
  assert.equal(nodes(tree, 'Save')[0].props.disabled, true);
  assert.ok(!text(tree).includes('Synthetic Jessica'));
  const dateField = nodes(tree, MealDatePicker)[0];
  assert.ok(dateField);
  dateField.props.onChange('2026-11-03');
  assert.equal(pending.arguments.eaten_on, '2026-11-03');
  assert.deepEqual(api.calls, []);
  tree = render();
  assert.ok(text(tree).includes('Nov 3, 2026'));
  assert.equal(nodes(tree, 'Save')[0].props.disabled, false);
  nodes(tree, 'Save')[0].props.onPress(); await saving;
  assert.deepEqual(api.calls.map((call) => call.path), ['/conversation/actions/prepare', '/conversation/actions/confirm']);
  assert.equal(api.calls[1].body.arguments.eaten_on, '2026-11-03');
  assert.deepEqual(api.calls[1].body.arguments.companion_ids, []);
});

test('an invalid explicit date correction clears the previous draft date and disables Save', () => {
  const api = actions(), h = hooks(); const { PendingCard, MealDatePicker } = cards(h);
  const pending = { key: 'synthetic', kind: 'log_meal', arguments: api.draftMeal(meal({
    category: 'chinese', date: { kind: 'iso', value: '2026-11-03' } }), []) };
  const rejected = api.enrichMeal(pending, meal({ slot: 'dinner' }), [], true);
  assert.equal(rejected.arguments.eaten_on, '');
  assert.equal(api.missingMealLine(rejected.arguments), 'When did you eat it?');
  h.reset();
  const tree = PendingCard({ pending: rejected, categories: [{ id: 'chinese', name: 'Chinese' }],
    people: [], busy: false, error: null, duplicate: false, onChange() {}, onCancel() {},
    onWhere() {}, onConfirm() { assert.fail('An invalid date cannot be saved'); } });
  assert.equal(nodes(tree, 'Save')[0].props.disabled, true);
  assert.equal(nodes(tree, MealDatePicker).length, 1);
  assert.deepEqual(api.calls, []);
});

test('partial Places results use success wording with an honest coverage limitation', () => {
  const labels = new Map([['chinese', 'Chinese']]);
  const partial = { required_craving: 'chinese', best_so_far: false, picks: [{ id: 'synthetic' }],
    search_status: 'partial', search_issue: 'timeout' };
  const line = protocol.recommendationLine(partial, true, labels);
  assert.equal(line, 'Found 1 eligible place; wider search timed out.');
  assert.ok(!line.includes('please retry'));
  assert.equal(protocol.recommendationLine({ ...partial, using_cached: true }, false, labels),
    'Using eligible earlier picks; current search timed out.');
  assert.notEqual(protocol.recommendationLine({ ...partial, picks: [], search_status: 'timeout' }, true, labels), line);
});
