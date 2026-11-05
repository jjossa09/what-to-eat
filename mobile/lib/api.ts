import AsyncStorage from '@react-native-async-storage/async-storage';

import { withInsightsDeadline } from './insights';
import { languageRequest, type ReasonsEnvelope, type ReasonsResponse } from './reasons';
import { supabase } from './supabase';
import { loadTakeaway, requestTakeaway, type TakeawayResult } from './takeaway';

// Our own API (EXPO_PUBLIC_API_URL). Every call carries the user's Supabase JWT.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Covers a Vercel cold start plus the ~8 s first round (NFR4).
const TIMEOUT_MS = 20_000;
// The question plan holds up the chat's first question; past this the chat uses the default
// order (P2-05). History only, so it is fast when the API is warm.
export const PLAN_TIMEOUT_MS = 5_000;
export const INSIGHTS_TIMEOUT_MS = 5_000;
export const TAKEAWAY_TIMEOUT_MS = 12_000;
export const PARSE_TIMEOUT_MS = 20_000;
export const RECOMMENDATIONS_TIMEOUT_MS = 28_000;

export type TakeawayResponse = {
  source: 'muse' | 'template' | 'none'; line: string | null;
  companion_refs: { placeholder: string; companion_id: string }[];
};

/** Independent of chart loading. Only the cutoff date is uploaded. */
export async function getInsightsTakeaway(
  stats: InsightsResponse, saved: readonly { id: string; name: string }[],
): Promise<TakeawayResult> {
  try {
    return await withInsightsDeadline(async (signal) => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || !API_URL || signal.aborted) throw new ApiError('auth');
      return await loadTakeaway({ user: session.user.id, date: stats.cutoff_date, stats, saved,
        storage: AsyncStorage, request: () => requestTakeaway(
          `${API_URL.replace(/\/$/, '')}/insights/takeaway`, session.access_token,
          stats.cutoff_date, signal,
        ) });
    }, TAKEAWAY_TIMEOUT_MS);
  } catch {
    return { source: 'none', line: null, cached: false };
  }
}

export type InsightCategory = { category_id: string; meal_count: number };
export type InsightSlot = 'breakfast' | 'lunch' | 'dinner' | 'late';
export type DistancePoint = { eaten_on: string; distance_m: number };
export type InsightCompanion = {
  companion_id: string;
  meal_count: number;
  category_meal_count: number;
  source_counts: { live: number; backfill: number; chat?: number };
  weekdays: { iso_day: number; meal_count: number }[];
  categories: InsightCategory[];
  leading_day_ids: number[] | null;
  leading_category_ids: string[] | null;
  pattern_status: 'available' | 'insufficient_data';
};
export type InsightsResponse = {
  complete: boolean;
  cutoff_date: string;
  summary: { meal_count: number; category_meal_count: number };
  companions: {
    companions: InsightCompanion[];
    with_company_meal_count: number;
    coverage: { unlinked_meals: number; contradictory_company_meals: number };
  };
  price_by_slot: {
    meal_slot: InsightSlot;
    levels: { level: number; paid_count: number; budget_count: number }[];
    missing_meal_count: number;
  }[];
  food_by_slot: {
    meal_slot: InsightSlot;
    category_meal_count: number;
    leaders: InsightCategory[];
  }[];
  distance_by_slot: {
    meal_slot: InsightSlot;
    measured_meal_count: number;
    median_m: number | null;
    points: DistancePoint[];
  }[];
  top_categories: InsightCategory[];
  coverage: {
    unknown_slot_meals: number;
    missing_price_meals: number;
    backfill_distance_meals: number;
    missing_distance_meals: number;
  };
};

/** Separate deadline includes auth, fetch, and body reading; other calls are unchanged. */
export function getInsights(asOf: string): Promise<InsightsResponse> {
  return withInsightsDeadline(async (signal) => {
    if (!API_URL) throw new ApiError('server');
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ApiError('auth');
    if (signal.aborted) throw new ApiError('network');
    const response = await fetch(
      `${API_URL.replace(/\/$/, '')}/insights?as_of=${encodeURIComponent(asOf)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    if (!response.ok) throw new ApiError(response.status === 401 ? 'auth' : 'server');
    return await response.json() as InsightsResponse;
  }, INSIGHTS_TIMEOUT_MS);
}

export type ApiErrorKind = 'network' | 'server' | 'auth' | 'conflict' | 'notfound';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, public code?: string) {
    super(kind);
  }
}

/** One authenticated call to our API. Throws ApiError with a kind, never upstream detail. */
async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T> {
  if (!API_URL) throw new ApiError('server');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('auth');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${API_URL.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) throw new ApiError('auth');
  if (response.status === 409) throw new ApiError('conflict');
  if (response.status === 404) throw new ApiError('notfound');
  if (!response.ok) throw new ApiError('server', path === '/recommendations'
    ? response.status === 504 ? 'places_timeout'
      : [502, 503].includes(response.status) ? 'places_unavailable' : undefined : undefined);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('server');
  }
}

export type ParseQuestionKey = 'craving' | 'budget' | 'distance' | 'refine' | 'open';
export type QuestionKey = ParseQuestionKey | 'company';
export type CompanyAnswer = 'solo' | string[] | null;

/** The 3 questions before round 1 (FR4). */
export type FirstKey = 'craving' | 'budget' | 'distance' | 'company';
export type RefinementKey = Exclude<FirstKey, 'company'>;

/** One question of the confidence gate's plan (P2-05, ML6), in asking order. */
export type PlanQuestion = {
  key: FirstKey;
  weak: boolean;
  /** The pre-selected chip: a category id, a budget level, or a radius. Null when weak. */
  prefill: string | number | string[] | null;
  predicted: string | number | string[] | null;
  top_prob: number;
  meals: number;
  level: string;
};

export type PlanResponse = {
  history_used: boolean;
  meal_slot: string;
  questions: PlanQuestion[];
  skipped: PlanQuestion | null;
};

/** The 3 questions in asking order, weak first (P2-05). History only: no places, no Muse. */
export function getQuestionPlan(localTime: string, newSearch = false): Promise<PlanResponse> {
  return request<PlanResponse>('POST', '/questions/plan', { local_time: localTime, new_search: newSearch }, PLAN_TIMEOUT_MS);
}

/** The refinement question with the highest information gain (ML10); its options are chips. */
export type NextQuestion = {
  key: RefinementKey;
  /** Category ids (craving), levels 1-4 (budget), or radii 15000 / 35000 (distance). */
  options: (string | number)[];
  gains: Record<RefinementKey, number>;
};

/** What one answer changes (chips or Muse-parsed text). Steps apply on the server. */
export type Change = {
  craving: string | null; // category id or 'anything'; null = not mentioned
  exclude_categories: string[];
  budget: 1 | 2 | 3 | 4 | 'cheaper' | 'pricier' | null;
  distance: 15000 | 35000 | 'closer' | 'farther' | null; // Close to me, I don't mind (P1-19)
  something_else: boolean;
};

export type TranscriptMessage = {
  role: 'assistant' | 'user';
  body: string;
  question_key?: QuestionKey | 'company';
  answer?: Record<string, string | number | boolean | null | string[]>;
  input_mode?: 'chip' | 'text' | 'prefill';
};

export type RoundRequest = {
  lat: number;
  lon: number;
  local_time: string;
  timezone?: string;
  craving: string | null;
  budget_level: number | null;
  radius_m: 15000 | 35000 | null;
  survey?: import('./companion').Survey;
  requirements_changed?: boolean;
  request_source?: 'typed' | 'chip' | 'retry';
  exclude_categories: string[];
  /** A follow-up's change; the server applies it to the answers above. */
  refine?: Partial<Change>;
  /** The user tapped None of these on the previous round (logged as the rejected reason). */
  none_of_these?: boolean;
  solo: boolean | null;
  companion_ids?: string[];
  session_id?: string;
  exclude_ids: string[];
  transcript: TranscriptMessage[];
  /** Round 1 only (P2-05): the question order the chat used, and where it came from. */
  asked_order?: FirstKey[];
  /** new_search: a search after a pick, craving first (the typed text is the craving). */
  plan_source?: 'plan' | 'fallback' | 'new_search';
  /** Round 1 only (P2-05 trace): the plan's pre-fills as received, and the chip that was
   * highlighted when each question was answered. Null = none. */
  prefilled?: { received: PrefillValues; shown: PrefillValues };
  company_prefilled?: { received: CompanyAnswer; shown: CompanyAnswer };
};

export type PrefillValues = {
  craving: string | null;
  budget: number | null;
  distance: 15000 | 35000 | null;
};

export type Pick = {
  rank: number;
  slot: string;
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
  category: string;
  address: string | null;
  reason: string;
};

export type RoundAnswers = {
  craving: string | null;
  budget_level: number | null;
  radius_m: number | null;
  exclude_categories: string[];
};

export type RoundResponse = {
  required_craving?: string | null;
  search_status?: 'complete' | 'incomplete' | 'timeout' | 'provider_error' | 'cached' | 'unsupported_category' | 'partial';
  search_issue?: 'timeout' | 'provider_error' | 'incomplete' | null;
  using_cached?: boolean;
  reasons_envelope?: ReasonsEnvelope | null;
  session_id: string | null;
  round: number | null;
  logged: boolean;
  /** Round 4 without a pick: the best cards already shown (ML10); can be fewer than 3. */
  best_so_far: boolean;
  /** The answers this round ran with; the next round continues from them. */
  answers: RoundAnswers;
  /** Null: no question would change the picks (or the cap round); show the fixed chips. */
  next_question: NextQuestion | null;
  /** The gate entry was saved (P2-05); never affects the round. */
  gate_logged: boolean;
  picks: Pick[];
};

export type ParseResponse = {
  /** chat: small talk or off-topic; answer is null and reply holds one short line. */
  status: 'ok' | 'not_sure' | 'chat';
  answer: Change | null;
  source: 'muse' | 'none';
  /** chat only: may hold a {name} placeholder the app fills in (the name never leaves the app). */
  reply: string | null;
};

/** Language calls bound auth, transport, and body reading with one deadline. */
async function languageCall<T>(path: string, body: unknown, timeout: number): Promise<T> {
  return languageRequest<T>(`${API_URL?.replace(/\/$/, '')}${path}`, body, async () => {
    if (!API_URL) throw new ApiError('server');
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ApiError('auth');
    return data.session.access_token;
  }, withInsightsDeadline, timeout);
}

export async function parseAnswer(questionKey: ParseQuestionKey, text: string): Promise<ParseResponse> {
  try {
    return await languageCall<ParseResponse>('/answers/parse', { question_key: questionKey, text }, 16_000);
  } catch (error) {
    if ((error instanceof ApiError && error.kind === 'auth')
      || (error instanceof Error && error.message === 'auth')) throw new ApiError('auth');
    return { status: 'not_sure', answer: null, source: 'none', reply: null };
  }
}

export function getReasons(envelope: ReasonsEnvelope): Promise<ReasonsResponse> {
  return languageCall('/reasons', envelope, 18_000);
}

export function getRecommendations(body: RoundRequest): Promise<RoundResponse> {
  return request<RoundResponse>('POST', '/recommendations', body, RECOMMENDATIONS_TIMEOUT_MS);
}

/** Companion actions include auth and body reading in one deadline, with no automatic retry. */
export function companionCall<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return withInsightsDeadline(async (signal) => {
    if (!API_URL) throw new ApiError('server');
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ApiError('auth');
    if (signal.aborted) throw new ApiError('network');
    const response = await fetch(`${API_URL.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let code: string | undefined;
      if (path.startsWith('/places/search?')) {
        const detail = await response.json().catch(() => null);
        if (['lookup_timeout', 'lookup_provider_error', 'lookup_invalid_response'].includes(detail?.detail)) code = detail.detail;
      }
      throw new ApiError(response.status === 401 ? 'auth' : response.status === 409 ? 'conflict' : 'server', code);
    }
    return await response.json() as T;
  }, Math.min(timeoutMs ?? (path === '/conversation/parse' ? PARSE_TIMEOUT_MS : 16_000),
    path === '/conversation/parse' ? PARSE_TIMEOUT_MS : 16_000));
}

export type Place = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
  category: string;
  address: string | null;
};

export type PlacesResponse = { radius_m: number; count: number; truncated: boolean; places: Place[] };

/** Nearby catering places (Geoapify through our API). One call. */
export function searchPlaces(lat: number, lon: number, radiusM: number): Promise<PlacesResponse> {
  const query = `lat=${lat}&lon=${lon}&radius_m=${radiusM}`;
  return request<PlacesResponse>('GET', `/places/search?${query}`);
}

// Funnel events (ML8). Only for rounds that were logged (a session_id came back).

export function logInterested(
  sessionId: string,
  round: number,
  placeId: string,
  kind: 'card' | 'directions',
): Promise<unknown> {
  return request('POST', `/sessions/${sessionId}/interested`, { round, place_id: placeId, kind });
}

export function logPicked(sessionId: string, round: number, placeId: string): Promise<unknown> {
  return request('POST', `/sessions/${sessionId}/picked`, { round, place_id: placeId });
}

export function logNone(sessionId: string): Promise<unknown> {
  return request('POST', `/sessions/${sessionId}/none`);
}

/** The device's local time with its UTC offset, e.g. 2026-11-02T19:30:00-05:00. */
export function localTimeIso(now: Date = new Date()): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/** The device's IANA zone, if the runtime knows it. */
export function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
