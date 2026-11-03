// Phone-only cache and name substitution. Dependencies are injected for Node tests.
import type { InsightsResponse, TakeawayResponse } from './api';

export type TakeawayResult = { source: TakeawayResponse['source']; line: string | null; cached: boolean };
type SavedCompanion = { id: string; name: string };
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> };

/** Body reading is part of the deadline, including transports that ignore abort. */
export async function requestTakeaway(
  url: string, token: string, asOf: string, signal: AbortSignal,
  send: typeof fetch = fetch,
): Promise<TakeawayResponse> {
  if (signal.aborted) throw new Error('Takeaway timeout');
  const response = await send(url, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ as_of: asOf }),
  });
  if (!response.ok) throw new Error('Takeaway unavailable');
  const body: TakeawayResponse = await response.json();
  if (signal.aborted) throw new Error('Takeaway timeout');
  return body;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// SHA-256, without a native module or Node dependency. Input is the existing JSON body.
export function sha256(text: string): string {
  const bytes: number[] = [];
  for (const char of text) {
    const n = char.codePointAt(0)!;
    if (n < 128) bytes.push(n);
    else if (n < 2048) bytes.push(192 | n >>> 6, 128 | n & 63);
    else if (n < 65536) bytes.push(224 | n >>> 12, 128 | n >>> 6 & 63, 128 | n & 63);
    else bytes.push(240 | n >>> 18, 128 | n >>> 12 & 63, 128 | n >>> 6 & 63, 128 | n & 63);
  }
  const length = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(length / 4294967296), low = length >>> 0;
  for (const word of [high, low]) for (let shift = 24; shift >= 0; shift -= 8) bytes.push(word >>> shift & 255);
  const k = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotate = (n: number, shift: number) => n >>> shift | n << (32 - shift);
  for (let block = 0; block < bytes.length; block += 64) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) w[i] = bytes[block + 4 * i] << 24 | bytes[block + 4 * i + 1] << 16
      | bytes[block + 4 * i + 2] << 8 | bytes[block + 4 * i + 3];
    for (let i = 16; i < 64; i++) w[i] = w[i - 16] + (rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ w[i - 15] >>> 3)
      + w[i - 7] + (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ w[i - 2] >>> 10);
    let [a, b, c, d, e, f, g, v] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = v + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + k[i] + w[i];
      const t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c);
      [a, b, c, d, e, f, g, v] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
    }
    [a, b, c, d, e, f, g, v].forEach((word, i) => { h[i] = (h[i] + word) >>> 0; });
  }
  return h.map((n) => n.toString(16).padStart(8, '0')).join('');
}

export function cacheKey(user: string, date: string, stats: InsightsResponse): string {
  return `insights-takeaway:v1:${sha256(canonical({ user, date, stats }))}`;
}

function valid(value: unknown): value is TakeawayResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as TakeawayResponse;
  return ['muse', 'template', 'none'].includes(v.source)
    && (v.line === null || typeof v.line === 'string' && v.line.length > 0 && v.line.length <= 90
      && !/[\r\n\u2028\u2029—]/.test(v.line))
    && Array.isArray(v.companion_refs) && v.companion_refs.every((ref) =>
      typeof ref?.companion_id === 'string' && /^Companion [1-9]\d*$/.test(ref.placeholder));
}

export function renderTakeaway(reply: TakeawayResponse, saved: readonly SavedCompanion[]): string | null {
  if (!reply.line) return null;
  const names = new Map(saved.map((c) => [c.id, c.name]));
  const refs = new Map(reply.companion_refs.map((r) => [r.placeholder, r.companion_id]));
  let missing = false;
  const line = reply.line.replace(/Companion\s+\d+/g, (placeholder) => {
    const name = names.get(refs.get(placeholder) ?? '');
    if (!name?.trim()) { missing = true; return ''; }
    return name;
  });
  return missing || line.length > 90 || /[\r\n\u2028\u2029—]/.test(line) ? null : line;
}

export async function loadTakeaway(options: {
  user: string; date: string; stats: InsightsResponse; saved: readonly SavedCompanion[];
  storage: Storage; request: () => Promise<TakeawayResponse>;
}): Promise<TakeawayResult> {
  const key = cacheKey(options.user, options.date, options.stats);
  const result = (reply: TakeawayResponse, cached: boolean): TakeawayResult =>
    ({ source: reply.source, line: renderTakeaway(reply, options.saved), cached });
  try {
    const raw = await options.storage.getItem(key);
    if (raw) {
      const stored: unknown = JSON.parse(raw);
      if (valid(stored) && stored.source === 'muse' && stored.line) return result(stored, true);
    }
  } catch { /* Cache failure never prevents the request. */ }
  try {
    const reply = await options.request();
    if (!valid(reply)) return { source: 'none', line: null, cached: false };
    if (reply.source === 'muse' && reply.line) {
      try { await options.storage.setItem(key, JSON.stringify(reply)); } catch { /* Display still works. */ }
    }
    return result(reply, false);
  } catch {
    return { source: 'none', line: null, cached: false };
  }
}
