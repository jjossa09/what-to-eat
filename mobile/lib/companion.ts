// Conversation protocol v2. Pure values and presentation helpers, no network or model logic.
export type SurveyKey = 'craving' | 'budget' | 'distance' | 'company';
export type FieldState = { value: string | number | string[] | null;
  status: 'unknown' | 'predicted' | 'uncertain' | 'confirmed';
  source: 'quiz' | 'model' | 'chip' | 'typed' | null; turn: number };
export type Survey = Record<SurveyKey, FieldState> & {
  exclusions: string[]; asked: SurveyKey[]; turn: number; recommend_now: boolean; unmatched: string[];
};
export type Update = { status: 'confirmed' | 'uncertain'; value: FieldState['value'] };
export type Patch = Partial<Record<SurveyKey, Update | null>> & {
  exclude?: string[]; allow?: string[]; budget_step?: 'cheaper' | 'pricier' | null;
  distance_step?: 'closer' | 'farther' | null; something_else?: boolean; unmatched?: string[];
};
export type DateToken = { kind: 'today' | 'yesterday' | 'weekday' | 'last_weekday' | 'iso'; value: string | null };
export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'late';
export type ChartId = 'top' | 'food' | 'price' | 'distance' | 'companions';
export type HistoryRange = 'today' | 'yesterday' | 'this_week' | 'last_7_days' | 'last_30_days' | 'this_month';
export type Intent =
  | { type: 'survey_patch' | 'recommend_now' | 'confirm' | 'cancel' | 'unknown' }
  | { type: 'log_meal'; category: string | null; dish: string | null; date: DateToken | null;
      slot: Slot | null; place_name: string | null; company: string[]; solo: boolean | null; stars: number | null }
  | { type: 'rate_meal'; reference: 'last' | 'food' | 'date'; category: string | null;
      date: DateToken | null; slot: Slot | null; stars: number | null }
  | { type: 'find_place'; name: string }
  | { type: 'history_query'; range: HistoryRange; chart_id: ChartId; slot: Slot | null }
  | { type: 'preference_change'; operation: 'add_favorite' | 'remove_favorite' | 'add_hard_no' | 'remove_hard_no'; category: string };
export type Interpretation = { intents: Intent[]; patch: Patch; understood: boolean;
  reply?: string | null;
  status?: 'ok' | 'partial' | 'unsupported' | 'ambiguous' | 'timeout' | 'truncated' | 'invalid_json' | 'invalid_fields' | 'unavailable' | 'rate_limited' | 'quota_exhausted' | 'daily_limit';
  invalid_fields?: string[] };
export type Person = { id: string; name: string };
export type ContextLine = { role: 'assistant' | 'user'; content: string };
export const OTIS_INTRO = "Hey, I'm Otis! I'll help you find food that fits your taste. What sounds good?";
export const SURVEY_KEYS: SurveyKey[] = ['craving', 'budget', 'distance', 'company'];
export const CHARTS: ChartId[] = ['top', 'food', 'price', 'distance', 'companions'];
export const SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner', 'late'];

export function emptySurvey(): Survey {
  const field = (): FieldState => ({ value: null, status: 'unknown', source: null, turn: 0 });
  return { craving: field(), budget: field(), distance: field(), company: field(),
    exclusions: [], asked: [], turn: 0, recommend_now: false, unmatched: [] };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function privateMessage(text: string, people: readonly Person[]) {
  let safe = text;
  const seen = new Set<string>();
  for (const person of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const name = person.name.trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || seen.has(normalized)) continue;
    seen.add(normalized);
    const matches = people.filter((p) => p.name.trim().toLocaleLowerCase() === normalized);
    const ref = matches.length === 1 ? `companion_${people.indexOf(matches[0]) + 1}` : 'companion_ambiguous';
    safe = safe.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(name)}(?=$|[^\\p{L}\\p{N}_])`, 'giu'),
      (_match, prefix: string) => `${prefix}${ref}`);
  }
  return { text: safe, companion_refs: people.map((_, i) => `companion_${i + 1}`) };
}

/** Redact again at send time, including names added since an earlier turn. Never persist. */
export function recentContext(lines: readonly ContextLine[], people: readonly Person[]): ContextLine[] {
  return lines.slice(-6).map((line) => ({ role: line.role,
    content: privateMessage(line.content, people).text.slice(0, 200) }));
}

/** Cache identity only. Eligibility and ranking remain server decisions. */
export function searchRequirements(state: Survey): string {
  return JSON.stringify([state.craving.value,
    state.craving.status === 'confirmed' && ['typed', 'chip'].includes(state.craving.source ?? ''),
    state.budget.value, state.distance.value, state.company.value, [...state.exclusions].sort()]);
}

export function recommendationLine(result: { required_craving?: string | null; best_so_far: boolean;
  search_status?: string; search_issue?: string | null; using_cached?: boolean;
  picks: readonly unknown[] }, first: boolean,
  labels: ReadonlyMap<string, string>): string | null {
  if (!result.picks.length) {
    if (result.search_status === 'unsupported_category') return 'I can’t verify that food category from place data; try another?';
    if (result.search_status === 'cached') return 'No earlier picks fit; try another cuisine?';
    if (result.search_status === 'timeout') return 'The wider search timed out; retry or change cuisine.';
    if (result.search_status === 'provider_error') return 'The wider search failed; retry or change cuisine.';
    if (result.search_status === 'incomplete') return 'The search was incomplete; retry or change cuisine.';
    if (result.required_craving) return `No verified ${labels.get(result.required_craving) ?? 'cuisine'} matches in this search. Try another cuisine?`;
    return 'No spots matched this search; try a wider area.';
  }
  if (result.search_status === 'partial') {
    const lead = result.using_cached ? 'Using eligible earlier picks' : `Found ${result.picks.length} eligible ${result.picks.length === 1 ? 'place' : 'places'}`;
    const scope = result.using_cached ? 'current search' : 'wider search';
    const issue = result.search_issue === 'timeout' ? `${scope} timed out`
      : result.search_issue === 'provider_error' ? `${scope} was unavailable` : 'coverage is incomplete';
    return `${lead}; ${issue}.`;
  }
  if (result.best_so_far) return 'Best so far.';
  if (result.required_craving && result.picks.length < 3) {
    const food = labels.get(result.required_craving) ?? 'cuisine';
    return `Found ${result.picks.length} verified ${food} ${result.picks.length === 1 ? 'match' : 'matches'}.`;
  }
  return first ? `Here are ${result.picks.length} spots.` : 'Here are a few more.';
}

export function companionIds(refs: readonly string[], people: readonly Person[]): string[] | null {
  const ids = refs.map((ref) => /^companion_[1-9]\d*$/.test(ref)
    ? people[Number(ref.slice(10)) - 1]?.id : undefined);
  return ids.every((id) => id !== undefined) && new Set(ids).size === ids.length ? ids as string[] : null;
}

export function calendarDate(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function localMealDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setFullYear(year, month - 1, day); parsed.setHours(12, 0, 0, 0);
  return year > 0 && calendarDate(parsed) === iso ? parsed : null;
}
export function validMealDate(iso: string, now = new Date()): boolean {
  return localMealDate(iso) !== null && iso <= calendarDate(now);
}
export function displayMealDate(iso: string): string {
  return localMealDate(iso)?.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }) ?? 'Date not set';
}
export function calendarDays(month: Date): (string | null)[] {
  const first = new Date(month); first.setDate(1); first.setHours(12, 0, 0, 0);
  const next = new Date(first); next.setMonth(next.getMonth() + 1);
  const last = new Date(next); last.setDate(0);
  const count = last.getDate();
  return Array.from({ length: 42 }, (_, i) => {
    const day = i - first.getDay() + 1;
    if (day < 1 || day > count) return null;
    const date = new Date(first); date.setDate(day); return calendarDate(date);
  });
}
export function resolveDate(token: DateToken | null, now = new Date()): string | null {
  if (!token || token.kind === 'weekday' || token.kind === 'last_weekday') return null;
  if (token.kind === 'iso') return token.value && validMealDate(token.value, now) ? token.value : null;
  const day = new Date(now);
  if (token.kind === 'yesterday') day.setDate(day.getDate() - 1);
  return calendarDate(day);
}

export function dispatch(intents: readonly Intent[]) {
  const confirmation = intents.find((i) => i.type === 'cancel' || i.type === 'confirm');
  const effects = intents.filter((i) => ['log_meal', 'rate_meal', 'preference_change'].includes(i.type));
  const reads = intents.filter((i) => i.type === 'history_query' || i.type === 'find_place');
  return { confirmation, effect: effects[0], second: effects[1]?.type, reads,
    recommend: intents.some((i) => i.type === 'recommend_now') };
}

export function changedLine(before: Survey, after: Survey, labels: ReadonlyMap<string, string>): string | null {
  const changes: string[] = [];
  for (const key of SURVEY_KEYS) {
    const field = after[key];
    if (field.status !== 'confirmed' || JSON.stringify(field) === JSON.stringify(before[key])) continue;
    if (key === 'craving') changes.push(field.value === null ? 'anything' : labels.get(String(field.value)) ?? 'food updated');
    if (key === 'budget') changes.push('$'.repeat(Number(field.value)));
    if (key === 'distance') changes.push(field.value === 15000 ? 'close by' : 'wider search');
    if (key === 'company') changes.push(field.value === 'solo' ? 'solo' : 'company updated');
  }
  if (JSON.stringify(before.exclusions) !== JSON.stringify(after.exclusions)) changes.push('exclusions updated');
  return changes.length ? `Got it: ${changes.join(', ')}.` : null;
}

export function validInterpretation(value: unknown, categories?: ReadonlySet<string>): value is Interpretation {
  if (!value || typeof value !== 'object') return false;
  const v = value as Interpretation;
  if (v.reply != null && (typeof v.reply !== 'string' || !v.reply.trim()
    || v.reply.length > 200 || /[\r\n]/.test(v.reply) || (v.reply.match(/\?/g) ?? []).length > 1)) return false;
  const allowed = new Set(['survey_patch', 'recommend_now', 'log_meal', 'rate_meal', 'find_place',
    'history_query', 'preference_change', 'confirm', 'cancel', 'unknown']);
  const category = (x: unknown) => typeof x === 'string' && (!categories || categories.has(x));
  const nullableText = (x: unknown, max: number) => x === null || typeof x === 'string' && x.length <= max;
  const date = (x: unknown) => x === null || !!x && typeof x === 'object'
    && ['today', 'yesterday', 'weekday', 'last_weekday', 'iso'].includes((x as DateToken).kind)
    && nullableText((x as DateToken).value, 10);
  const slot = (x: unknown) => x === null || SLOTS.includes(x as Slot);
  const stars = (x: unknown) => x === null || Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 5;
  const strings = (x: unknown, max: number) => Array.isArray(x) && x.length <= max && x.every((s) => typeof s === 'string');
  const patch = v.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
  if (Object.keys(patch).some((k) => ![...SURVEY_KEYS, 'exclude', 'allow', 'budget_step', 'distance_step', 'something_else', 'unmatched'].includes(k))) return false;
  for (const key of SURVEY_KEYS) {
    const update = patch[key];
    if (update == null) continue;
    if (typeof update !== 'object' || !['confirmed', 'uncertain'].includes(update.status)
      || Object.keys(update).some((k) => !['status', 'value'].includes(k))) return false;
    const x = update.value;
    if (update.status === 'uncertain') { if (x !== null) return false; continue; }
    if (key === 'craving' && x !== null && !category(x)) return false;
    if (key === 'budget' && !(typeof x === 'number' && [1, 2, 3, 4].includes(x))) return false;
    if (key === 'distance' && !(typeof x === 'number' && [15000, 35000].includes(x))) return false;
    if (key === 'company' && x !== 'solo' && !(strings(x, 20) && (x as string[]).length > 0
      && (x as string[]).every((s) => /^companion_[1-9]\d*$/.test(s)))) return false;
  }
  for (const key of ['exclude', 'allow'] as const) {
    if (patch[key] !== undefined && (!strings(patch[key], 24) || !patch[key]!.every(category))) return false;
  }
  if (patch.budget_step != null && !['cheaper', 'pricier'].includes(patch.budget_step)) return false;
  if (patch.distance_step != null && !['closer', 'farther'].includes(patch.distance_step)) return false;
  if (patch.something_else !== undefined && typeof patch.something_else !== 'boolean') return false;
  if (patch.unmatched !== undefined && (!strings(patch.unmatched, 8)
    || !patch.unmatched.every((x) => ['menu', 'seating', 'hours', 'health', 'amenity', 'other', 'price_range', 'result_count'].includes(x)))) return false;
  return typeof v.understood === 'boolean' && Array.isArray(v.intents) && v.intents.length <= 8
    && v.intents.every((i) => i && typeof i === 'object' && allowed.has(i.type))
    && v.intents.every((i) => {
      if (i.type === 'log_meal') return (i.category === null || category(i.category)) && nullableText(i.dish, 60)
        && date(i.date) && slot(i.slot) && nullableText(i.place_name, 80) && strings(i.company, 20)
        && i.company.every((x) => /^companion_[1-9]\d*$/.test(x)) && stars(i.stars)
        && (i.solo === null || typeof i.solo === 'boolean');
      if (i.type === 'rate_meal') return ['last', 'food', 'date'].includes(i.reference)
        && (i.category === null || category(i.category)) && date(i.date) && slot(i.slot) && stars(i.stars);
      if (i.type === 'find_place') return typeof i.name === 'string' && !!i.name.trim() && i.name.length <= 80;
      if (i.type === 'history_query') return CHARTS.includes(i.chart_id) && slot(i.slot)
        && ['today', 'yesterday', 'this_week', 'last_7_days', 'last_30_days', 'this_month'].includes(i.range);
      if (i.type === 'preference_change') return category(i.category)
        && ['add_favorite', 'remove_favorite', 'add_hard_no', 'remove_hard_no'].includes(i.operation);
      return Object.keys(i).every((key) => key === 'type');
    });
}

export function parseFailureLine(response: unknown): string {
  const status = response && typeof response === 'object' ? (response as Interpretation).status : null;
  if (status === 'rate_limited') return 'Chat is busy; wait a moment or use a chip.';
  if (status === 'quota_exhausted') return 'Chat credits are unavailable; food chips still work.';
  if (status === 'daily_limit') return 'Chat reached its daily limit; food chips still work.';
  if (status === 'timeout') return 'That took too long; try again or use a chip.';
  if (status === 'unavailable') return 'Chat parsing is unavailable; try a chip or retry.';
  if (status === 'truncated') return 'That response was cut short; try one request at a time.';
  if (status === 'invalid_json' || status === 'invalid_fields') return 'I couldn’t validate that; try a chip or rephrase.';
  return 'What would you like help with: food picks, a meal, or your history?';
}

export function limitationLines(unmatched: readonly string[]): string[] {
  const lines = new Set<string>();
  for (const kind of unmatched) {
    if (kind === 'price_range') lines.add('I use $ to $$$$ budgets; exact prices aren’t verified.');
    else if (kind === 'result_count') lines.add('I show up to three verified places per round.');
    else if (kind === 'menu') lines.add('I can’t verify menu items; try a supported food category.');
    else lines.add('I can’t verify that from place data.');
  }
  return [...lines];
}

export function invalidFieldLine(fields: readonly string[]): string | null {
  if (fields.includes('meal_company')) return 'Company is not set; select anyone who actually joined.';
  if (fields.includes('budget') || fields.includes('budget_step')) return 'Which budget level works: $ to $$$$?';
  if (fields.includes('distance') || fields.includes('distance_step')) return 'Stay close, or use a wider search?';
  if (fields.includes('craving') || fields.includes('meal_category')) return 'Which food category did you mean?';
  if (fields.includes('meal_date')) return 'What date did you eat it?';
  if (fields.includes('meal_stars')) return 'Ratings use 1 to 5 stars.';
  return fields.length ? 'I kept the clear details; please clarify the rest.' : null;
}
