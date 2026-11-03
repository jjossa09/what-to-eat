// Pure presentation and injected loading: no React Native, Supabase, or network imports.
import type { InsightCategory, InsightsResponse } from './api';

export type InsightBar = {
  id: string;
  label: string;
  value: number;
  valueLabel: string;
};
export type PriceSegment = {
  level: number;
  label: string;
  paidCount: number;
  budgetCount: number;
  fraction: number;
  paidFraction: number;
  budgetFraction: number;
};
export type InsightGroup = {
  id: string; label?: string; detail?: string; bars: InsightBar[];
  segments?: PriceSegment[];
};
export type CompanyRing = { value: number; total: number; fraction: number; label: string };
export type InsightCard = {
  groups: InsightGroup[];
  emptyText: string;
  note?: string;
  unavailable?: string;
  ring?: CompanyRing;
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
const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', late: 'Late' };

export function mealCount(count: number, qualifier = ''): string {
  return `${count}${qualifier ? ` ${qualifier}` : ''} ${count === 1 ? 'meal' : 'meals'}`;
}

export type MotionRow = { id: string; kind: 'bar' | 'ring'; index: number };

export function motionConfig(row: MotionRow, reduceMotion: boolean) {
  return {
    initial: reduceMotion ? 1 : 0,
    duration: reduceMotion ? 0 : row.kind === 'ring' ? 500 : 400,
    delay: reduceMotion || row.kind === 'ring' ? 0 : row.index * 50,
    useNativeDriver: row.kind === 'bar',
  };
}

/** Each chart has its own stagger; a price slot is one bar, not four animations. */
export function openingRows(cards: InsightCards): MotionRow[] {
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
  return {
    value, finish,
    begin(rows: readonly MotionRow[], reduceMotion: boolean) {
      if (opened) {
        if (reduceMotion) finish();
        return;
      }
      // Register the initial dataset before marking opened. Later refresh rows start final.
      for (const row of rows) value(row.id);
      opened = true;
      finish();
      for (const row of rows) {
        const entry = entries.get(row.id)!;
        const config = motionConfig(row, reduceMotion);
        driver.set(entry.value, config.initial);
        if (!reduceMotion) entry.stop = driver.animate(entry.value, config);
      }
      if (reduceMotion) finish();
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
): Extract<InsightsState, { status: 'ready' }> {
  const labels = new Map(categories.map((c) => [c.id, c.name]));
  const names = new Map(companions.map((c) => [c.id, c.name]));
  const categoryBar = (c: InsightCategory): InsightBar => ({
    id: c.category_id, label: labels.get(c.category_id) ?? c.category_id,
    value: c.meal_count, valueLabel: mealCount(c.meal_count),
  });
  const people = response.companions.companions;
  const missingNames = people.some((c) => !names.get(c.companion_id)?.trim());
  const includesBudgets = response.price_by_slot.some((s) => s.levels.some((l) => l.budget_count > 0));
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
    price: { emptyText: EMPTY_TEXT.price, note: includesBudgets ? 'Includes budgets' : undefined,
      groups: response.price_by_slot.map((s) => {
        const priced = s.levels.reduce((n, l) => n + l.paid_count + l.budget_count, 0);
        return { id: s.meal_slot, label: SLOT_LABELS[s.meal_slot],
          detail: `${s.missing_meal_count} missing`, bars: [],
          segments: s.levels.map((l) => {
            const count = l.paid_count + l.budget_count;
            return { level: l.level, label: '$'.repeat(l.level),
              paidCount: l.paid_count, budgetCount: l.budget_count,
              fraction: priced ? count / priced : 0,
              paidFraction: count ? l.paid_count / count : 0,
              budgetFraction: count ? l.budget_count / count : 0 };
          }),
        };
      }) },
    distance: { emptyText: EMPTY_TEXT.distance, note: 'Straight-line',
      groups: [{ id: 'distance', bars: response.distance_by_slot
        .filter((s) => s.median_m !== null).map((s) => ({
          id: s.meal_slot, label: SLOT_LABELS[s.meal_slot], value: s.median_m!,
          valueLabel: `${(s.median_m! / 1609.344).toFixed(1)} mi · ${mealCount(s.measured_meal_count)}`,
        })) }] },
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
): Promise<InsightsState> {
  try {
    const [response, companions] = await Promise.all([
      readInsights(asOf), Promise.resolve().then(readCompanions).catch(() => []),
    ]);
    return mapInsights(response, companions, categories);
  } catch {
    return { status: 'unavailable' };
  }
}
