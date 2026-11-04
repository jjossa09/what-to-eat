import type { ReasonsObserver } from './reasons';

export type OtisState = 'idle' | 'thinking' | 'happy';
export type OtisRound = {
  userId: string;
  sessionId: string | null;
  round: number | null;
  generation: number;
};
type Snapshot = Readonly<{ state: OtisState; active: boolean }>;
type Phase = 'complete' | 'working' | 'reasons' | 'display';
type Schedule = (callback: () => void, ms: number) => () => void;

const schedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** UI lifecycle only. Requests, validation and deduplication belong to ReasonsCache. */
export class OtisController {
  private token = 0;
  private roundKey: string | null = null;
  private phase: Phase = 'complete';
  private pending = new Set<string>();
  private suppressed = false;
  private stopHappy: (() => void) | undefined;
  private snapshot: Snapshot = { state: 'idle', active: false };
  private listeners = new Set<() => void>();
  private happyMs: number;
  private schedule: Schedule;

  constructor(happyMs: number, clock: Schedule = schedule) {
    this.happyMs = happyMs;
    this.schedule = clock;
  }

  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: OtisState, active = this.snapshot.active) {
    if (state === this.snapshot.state && active === this.snapshot.active) return;
    this.snapshot = { state, active };
    this.listeners.forEach((listener) => listener());
  }

  private clearHappy() {
    this.stopHappy?.();
    this.stopHappy = undefined;
  }

  setActive(active: boolean) {
    if (!active) {
      this.clearHappy();
      if (this.phase === 'display') this.suppressed = true;
    }
    this.publish(!active && this.snapshot.state === 'happy' ? 'idle' : this.snapshot.state, active);
  }

  begin(): number {
    this.reset();
    this.phase = 'working';
    this.publish('thinking');
    return this.token;
  }

  finish(token: number) {
    if (token !== this.token || this.phase === 'complete') return;
    this.phase = 'complete';
    this.pending.clear();
    this.clearHappy();
    this.publish('idle');
  }

  private reset() {
    this.token++;
    this.roundKey = null;
    this.phase = 'complete';
    this.pending.clear();
    this.suppressed = false;
    this.clearHappy();
  }

  cancel() {
    this.reset();
    this.publish('idle');
  }

  observeReasons(token: number, round: OtisRound, ids: readonly string[]): ReasonsObserver {
    const key = JSON.stringify([round.userId, round.sessionId, round.round, round.generation]);
    if (token === this.token && this.phase === 'working') {
      this.roundKey = key;
      this.pending = new Set(ids);
      this.phase = 'reasons';
      if (!ids.length || this.pending.size !== ids.length) this.finish(token);
    }
    const current = () => token === this.token && key === this.roundKey;
    return {
      current,
      accepted: () => {
        if (!current() || this.phase !== 'reasons') return;
        this.phase = 'display';
        this.suppressed ||= !this.snapshot.active;
      },
      fallback: () => { if (current()) this.finish(token); },
      displayed: (id) => {
        if (!current() || this.phase !== 'display' || !this.pending.delete(id) || this.pending.size) return;
        this.phase = 'complete';
        if (this.suppressed || !this.snapshot.active) {
          this.publish('idle');
          return;
        }
        this.stopHappy = this.schedule(() => {
          if (current() && this.phase === 'complete' && this.snapshot.state === 'happy') {
            this.stopHappy = undefined;
            this.publish('idle');
          }
        }, this.happyMs);
        this.publish('happy');
      },
    };
  }
}
