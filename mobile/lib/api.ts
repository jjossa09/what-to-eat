import { supabase } from './supabase';

// Our own API (EXPO_PUBLIC_API_URL). Every call carries the user's Supabase JWT.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Covers a Vercel cold start plus the ~8 s first round (NFR4).
const TIMEOUT_MS = 20_000;

export type ApiErrorKind = 'network' | 'server' | 'auth' | 'conflict' | 'notfound';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind) {
    super(kind);
  }
}

/** One authenticated call to our API. Throws ApiError with a kind, never upstream detail. */
async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!API_URL) throw new ApiError('server');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('auth');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
  if (!response.ok) throw new ApiError('server');
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError('server');
  }
}

export type QuestionKey = 'craving' | 'budget' | 'distance' | 'refine' | 'open';

/** What one answer changes (chips or Muse-parsed text). Steps apply on the server. */
export type Change = {
  craving: string | null; // category id or 'anything'; null = not mentioned
  exclude_categories: string[];
  budget: 1 | 2 | 3 | 4 | 'cheaper' | 'pricier' | null;
  distance: 1500 | 5000 | 15000 | 'closer' | 'farther' | null;
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
  budget_level: number;
  radius_m: 1500 | 5000 | 15000;
  exclude_categories: string[];
  /** A follow-up's change; the server applies it to the answers above. */
  refine?: Partial<Change>;
  solo: boolean | null;
  session_id?: string;
  exclude_ids: string[];
  transcript: TranscriptMessage[];
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
  session_id: string | null;
  round: number | null;
  logged: boolean;
  /** Round 4 without a pick: the best cards already shown (ML10); can be fewer than 3. */
  best_so_far: boolean;
  /** The answers this round ran with; the next round continues from them. */
  answers: RoundAnswers;
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

/** Typed text -> the same change a chip gives, not sure, or a chat line. One Muse call. */
export function parseAnswer(questionKey: QuestionKey, text: string): Promise<ParseResponse> {
  return request<ParseResponse>('POST', '/answers/parse', { question_key: questionKey, text });
}

export function getRecommendations(body: RoundRequest): Promise<RoundResponse> {
  return request<RoundResponse>('POST', '/recommendations', body);
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
