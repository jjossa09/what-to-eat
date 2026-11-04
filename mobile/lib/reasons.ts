// Request lifecycle and animation orchestration, independent of React Native for tests.
export type ReasonsEnvelope = { payload: string; signature: string };
export type ReasonsResponse = { source: 'muse' | 'template'; reasons: { id: string; line: string }[] };

/** Presentation observer, scoped to one operation and round. Never starts a request. */
export type ReasonsObserver = {
  current: () => boolean;
  accepted: () => void;
  fallback: () => void;
  displayed: (id: string) => void;
};

export class ReasonsCache {
  private entries = new Map<string, Promise<ReasonsResponse | null>>();
  private generation = 0;

  current() { return this.generation; }
  isCurrent(generation: number) { return generation === this.generation; }
  invalidate() { this.generation++; }
  clear() { this.invalidate(); this.entries.clear(); }

  watch(key: string, ids: readonly string[], generation: number,
    request: () => Promise<ReasonsResponse>, apply: (result: ReasonsResponse) => void,
    fallback?: () => void) {
    let live = true;
    if (this.isCurrent(generation)) {
      this.load(key, ids, request).then((result) => {
        if (live && this.isCurrent(generation)) {
          if (result) apply(result);
          else fallback?.();
        }
      });
    }
    return () => { live = false; };
  }

  load(key: string, ids: readonly string[], request: () => Promise<ReasonsResponse>) {
    const cached = this.entries.get(key);
    if (cached) return cached;
    const pending = Promise.resolve().then(request).then((result) => {
      if (result.source !== 'muse' || !Array.isArray(result.reasons)
        || result.reasons.length !== ids.length
        || new Set(result.reasons.map((r) => r.id)).size !== ids.length
        || result.reasons.some((r) => !ids.includes(r.id) || typeof r.line !== 'string'
          || !r.line.trim() || r.line.length > 90 || /[\r\n]/.test(r.line))) return null;
      return result;
    }).catch(() => null);
    // Failed attempts remain cached too: rerenders never retry automatically.
    this.entries.set(key, pending);
    return pending;
  }
}

export type Fade = (opacity: number, duration: number, done: () => void) => () => void;

/** Both the response and animation callback must still belong to the active round. */
export function swapReason(
  reduceMotion: boolean, current: () => boolean, apply: () => void, fade: Fade,
  displayed?: () => void,
): () => void {
  let cancelled = false;
  let stop = () => {};
  const live = () => !cancelled && current();
  if (live()) {
    if (reduceMotion) {
      apply();
      if (live()) displayed?.();
    } else stop = fade(0, 90, () => {
      if (cancelled) return;
      if (!live()) { stop = fade(1, 0, () => {}); return; }
      apply();
      stop = fade(1, 90, () => { if (live()) displayed?.(); });
    });
  }
  return () => { cancelled = true; stop(); };
}

export async function languageRequest<T>(
  url: string, body: unknown, authenticate: () => Promise<string>,
  deadline: <R>(work: (signal: AbortSignal) => Promise<R>, ms: number) => Promise<R>,
  timeoutMs: number, send: typeof fetch = fetch,
): Promise<T> {
  return deadline(async (signal) => {
    const token = await authenticate();
    if (signal.aborted) throw new Error('Language request timeout');
    const response = await send(url, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 401 ? 'auth' : 'Language unavailable');
    const result = await response.json() as T;
    if (signal.aborted) throw new Error('Language request timeout');
    return result;
  }, timeoutMs);
}
