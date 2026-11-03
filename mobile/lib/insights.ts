// Pure presentation and injected loading: no React Native, Supabase, or network imports.
import type { DistancePoint, InsightCategory, InsightSlot, InsightsResponse } from './api';

export type InsightBar = {
  id: string;
  label: string;
  value: number;
  valueLabel: string;
  color?: string;
};
export type PriceSegment = {
  level: number;
  label: string;
  paidCount: number;
  budgetCount: number;
  fraction: number;
};
export type InsightGroup = {
  id: string; label?: string; detail?: string; bars: InsightBar[];
  segments?: PriceSegment[];
  budgetNote?: string;
};
export type DistanceSlot = {
  id: InsightSlot; label: string; points: DistancePoint[];
  median_m: number | null; measured_meal_count: number;
};
export type CompanyRing = { value: number; total: number; fraction: number; label: string };
export type InsightCard = {
  groups: InsightGroup[];
  emptyText: string;
  note?: string;
  unavailable?: string;
  ring?: CompanyRing;
  timeline?: DistanceSlot[];
};
export type InsightCards = Record<'top' | 'food' | 'price' | 'distance' | 'companions', InsightCard>;
export type InsightsState = { status: 'loading' } | { status: 'unavailable' } | {
  status: 'ready';
  response: InsightsResponse;
  cards: InsightCards;
  note?: string;
  emptyText?: string;
  mostEatenIds: string[];
};
type Named = { id: string; name: string };

export const EMPTY_TEXT = {
  top: 'No food saved', food: 'No food saved', price: 'No prices yet',
  distance: 'No distances yet', companions: 'No companions yet',
};
export const SLOT_ORDER: readonly InsightSlot[] = ['breakfast', 'lunch', 'dinner', 'late'];
const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', late: 'Late' };

export function mealCount(count: number, qualifier = ''): string {
  return `${count}${qualifier ? ` ${qualifier}` : ''} ${count === 1 ? 'meal' : 'meals'}`;
}

export function defaultDistanceSlot(slots: readonly DistanceSlot[]): InsightSlot {
  return SLOT_ORDER.reduce((best, id) => {
    const count = (slot: InsightSlot) => slots.find((s) => s.id === slot)?.points.length ?? 0;
    return count(id) > count(best) ? id : best;
  }, SLOT_ORDER[0]);
}

export function formatMiles(meters: number): string {
  if (meters === 0) return '0 mi';
  const miles = meters / 1609.344;
  return miles < 0.1 ? '<0.1 mi' : `${miles.toFixed(1)} mi`;
}

/** Normalize calendar dates, not indexes or timezone-shifted instants. */
export function timelineGeometry(slot: DistanceSlot) {
  const day = (iso: string) => {
    const [year, month, date] = iso.split('-').map(Number);
    return Date.UTC(year, month - 1, date);
  };
  const first = slot.points[0]?.eaten_on;
  const last = slot.points.at(-1)?.eaten_on;
  const start = first ? day(first) : 0;
  const span = last ? day(last) - start : 0;
  const maximum = Math.max(0, ...slot.points.map((p) => p.distance_m));
  return {
    first, last, maximum,
    points: slot.points.map((p) => ({ ...p,
      x: span ? (day(p.eaten_on) - start) / span : 0.5,
      y: maximum ? 1 - p.distance_m / maximum : 1,
    })),
    medianY: maximum && slot.median_m !== null ? 1 - slot.median_m / maximum : 1,
    message: slot.points.length === 0 ? 'No distances yet'
      : slot.points.length === 1 ? '2 meals needed for a trend' : undefined,
  };
}

export type MotionRow = {
  id: string; kind: 'bar' | 'ring' | 'axes' | 'trace' | 'typical'; index: number;
  delayMs?: number;
};

export function motionConfig(row: MotionRow, reduceMotion: boolean) {
  return {
    initial: reduceMotion ? 1 : 0,
    duration: reduceMotion ? 0 : ({ bar: 400, ring: 500, axes: 200, trace: 600, typical: 200 })[row.kind],
    delay: reduceMotion ? 0 : row.delayMs ?? (row.kind === 'bar' ? row.index * 50 : row.kind === 'trace' ? 200 : 0),
    useNativeDriver: row.kind !== 'ring' && row.kind !== 'trace',
  };
}

export function timelineRows(pointCount: number): MotionRow[] {
  if (!pointCount) return [];
  return [
    { id: 'distance:axes', kind: 'axes', index: 0 },
    ...(pointCount >= 2 ? [{ id: 'distance:trace', kind: 'trace' as const, index: 0 }] : []),
    { id: 'distance:typical', kind: 'typical', index: 0, delayMs: pointCount >= 2 ? 800 : 200 },
  ];
}

/** Each chart has its own stagger; a price slot is one bar, not four animations. */
export function openingRows(cards: InsightCards, selectedSlot?: InsightSlot): MotionRow[] {
  const rows: MotionRow[] = [];
  for (const [key, card] of Object.entries(cards)) {
    if (card.unavailable) continue;
    let index = 0;
    for (const group of card.groups) {
      if (group.segments?.some((s) => s.fraction > 0)) {
        rows.push({ id: `${key}:${group.id}`, kind: 'bar', index: index++ });
      } else {
        for (const bar of group.bars) {
          rows.push({ id: `${key}:${group.id}:${bar.id}`, kind: 'bar', index: index++ });
        }
      }
    }
    if (card.ring) rows.push({ id: `${key}:ring`, kind: 'ring', index: 0 });
    if (card.timeline) {
      const id = selectedSlot ?? defaultDistanceSlot(card.timeline);
      rows.push(...timelineRows(card.timeline.find((s) => s.id === id)?.points.length ?? 0));
    }
  }
  return rows;
}

/** Injected animation driver keeps this opening lifecycle testable without React Native. */
export function createOpeningMotion<T>(driver: {
  value: (initial: number) => T;
  set: (value: T, final: number) => void;
  animate: (value: T, config: ReturnType<typeof motionConfig>) => () => void;
}) {
  const entries = new Map<string, { value: T; stop?: () => void }>();
  let opened = false;
  const value = (id: string): T => {
    let entry = entries.get(id);
    if (!entry) {
      entry = { value: driver.value(opened ? 1 : 0) };
      entries.set(id, entry);
    }
    return entry.value;
  };
  const finish = () => {
    for (const entry of entries.values()) {
      entry.stop?.();
      entry.stop = undefined;
      driver.set(entry.value, 1);
    }
  };
  const play = (rows: readonly MotionRow[], reduceMotion: boolean) => {
    for (const row of rows) {
      value(row.id);
      const entry = entries.get(row.id)!;
      entry.stop?.();
      entry.stop = undefined;
      const config = motionConfig(row, reduceMotion);
      driver.set(entry.value, config.initial);
      if (!reduceMotion) entry.stop = driver.animate(entry.value, config);
    }
  };
  return {
    value, finish,
    switchTimeline(pointCount: number, reduceMotion: boolean) {
      for (const [id, entry] of entries) {
        if (!id.startsWith('distance:')) continue;
        entry.stop?.();
        entry.stop = undefined;
        driver.set(entry.value, 1);
      }
      play(timelineRows(pointCount), reduceMotion);
    },
    begin(rows: readonly MotionRow[], reduceMotion: boolean) {
      if (opened) {
        if (reduceMotion) finish();
        return;
      }
      // Register the initial dataset before marking opened. Later refresh rows start final.
      for (const row of rows) value(row.id);
      opened = true;
      finish();
      play(rows, reduceMotion);
    },
  };
}

/** A racing deadline also handles a stalled auth or body promise that ignores abort. */
export async function withInsightsDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>, timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Insights timeout'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function localInsightsDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function mapInsights(
  response: InsightsResponse, companions: readonly Named[], categories: readonly Named[],
  categoryColors: Readonly<Record<string, string>> = {},
): Extract<InsightsState, { status: 'ready' }> {
  const labels = new Map(categories.map((c) => [c.id, c.name]));
  const names = new Map(companions.map((c) => [c.id, c.name]));
  const categoryBar = (c: InsightCategory): InsightBar => ({
    id: c.category_id, label: labels.get(c.category_id) ?? c.category_id,
    value: c.meal_count, valueLabel: mealCount(c.meal_count),
    color: categoryColors[c.category_id] ?? categoryColors.other,
  });
  const people = response.companions.companions;
  const missingNames = people.some((c) => !names.get(c.companion_id)?.trim());
  const total = response.summary.meal_count;
  const withCompany = response.companions.with_company_meal_count;
  if (!Number.isInteger(withCompany) || withCompany < 0 || withCompany > total) {
    throw new Error('Invalid company count');
  }
  const cards: InsightCards = {
    top: { emptyText: EMPTY_TEXT.top,
      note: response.summary.category_meal_count ? mealCount(response.summary.category_meal_count, 'food') : undefined,
      groups: [{ id: 'top', bars: response.top_categories.map(categoryBar) }] },
    food: { emptyText: EMPTY_TEXT.food, groups: response.food_by_slot.map((s) => ({
      id: s.meal_slot, label: SLOT_LABELS[s.meal_slot],
      detail: s.category_meal_count ? mealCount(s.category_meal_count, 'food') : undefined,
      bars: s.leaders.map(categoryBar),
    })) },
    price: { emptyText: EMPTY_TEXT.price,
      groups: response.price_by_slot.map((s) => {
        const priced = s.levels.reduce((n, l) => n + l.paid_count + l.budget_count, 0);
        const budgets = s.levels.reduce((n, l) => n + l.budget_count, 0);
        return { id: s.meal_slot, label: SLOT_LABELS[s.meal_slot],
          detail: `${s.missing_meal_count} missing`, bars: [],
          budgetNote: budgets ? `${budgets} from budgets` : undefined,
          segments: s.levels.map((l) => {
            const count = l.paid_count + l.budget_count;
            return { level: l.level, label: '$'.repeat(l.level),
              paidCount: l.paid_count, budgetCount: l.budget_count,
              fraction: priced ? count / priced : 0 };
          }),
        };
      }) },
    distance: { emptyText: EMPTY_TEXT.distance, note: 'Straight-line',
      groups: [], timeline: response.distance_by_slot.map((s) => {
        if (!Array.isArray(s.points) || s.points.length !== s.measured_meal_count) {
          throw new Error('Invalid distance points');
        }
        return { id: s.meal_slot, label: SLOT_LABELS[s.meal_slot], points: s.points,
          median_m: s.median_m, measured_meal_count: s.measured_meal_count };
      }) },
    companions: { emptyText: EMPTY_TEXT.companions,
      unavailable: missingNames ? 'Names unavailable' : undefined,
      ring: { value: withCompany, total, fraction: total ? withCompany / total : 0,
        label: `With company: ${withCompany} of ${mealCount(total)}` },
      groups: missingNames ? [] : [{ id: 'companions', bars: people.map((c) => ({
        id: c.companion_id, label: names.get(c.companion_id)!,
        value: c.meal_count, valueLabel: `${c.meal_count} of ${mealCount(total)}`,
      })) }] },
  };
  const first = response.top_categories[0];
  return { status: 'ready', response, cards,
    note: response.complete ? undefined : 'Some history is missing',
    emptyText: response.summary.meal_count === 0
      ? response.complete ? 'No meals yet' : 'No usable data' : undefined,
    mostEatenIds: response.top_categories.filter((c) => c.meal_count === first?.meal_count)
      .map((c) => c.category_id),
  };
}

/** Read numbers and local labels in parallel. Label failure affects only its card. */
export async function loadInsights(
  asOf: string,
  readInsights: (asOf: string) => Promise<InsightsResponse>,
  readCompanions: () => Promise<readonly Named[]>,
  categories: readonly Named[],
  categoryColors: Readonly<Record<string, string>> = {},
): Promise<InsightsState> {
  try {
    const [response, companions] = await Promise.all([
      readInsights(asOf), Promise.resolve().then(readCompanions).catch(() => []),
    ]);
    return mapInsights(response, companions, categories, categoryColors);
  } catch {
    return { status: 'unavailable' };
  }
}
