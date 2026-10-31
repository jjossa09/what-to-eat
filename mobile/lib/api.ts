import { supabase } from './supabase';

// Our own API (EXPO_PUBLIC_API_URL). Every call carries the user's Supabase JWT.
const API_URL = process.env.EXPO_PUBLIC_API_URL;

// Covers a Vercel cold start plus the ~8 s first round (NFR4).
const TIMEOUT_MS = 20_000;

export type ApiErrorKind = 'network' | 'server' | 'auth';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind) {
    super(kind);
  }
}

export type TranscriptMessage = {
  role: 'assistant' | 'user';
  body: string;
  question_key?: 'craving' | 'budget' | 'distance' | 'company';
  answer?: Record<string, string | number | boolean | null>;
  input_mode?: 'chip' | 'prefill';
};

export type RoundRequest = {
  lat: number;
  lon: number;
  local_time: string;
  timezone?: string;
  craving: string | null;
  budget_level: number;
  radius_m: 1500 | 5000 | 15000;
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

export type RoundResponse = {
  session_id: string | null;
  round: number | null;
  logged: boolean;
  picks: Pick[];
};

export async function getRecommendations(body: RoundRequest): Promise<RoundResponse> {
  if (!API_URL) throw new ApiError('server');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('auth');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_URL.replace(/\/$/, '')}/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError('network');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401) throw new ApiError('auth');
  if (!response.ok) throw new ApiError('server');
  try {
    return (await response.json()) as RoundResponse;
  } catch {
    throw new ApiError('server');
  }
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
