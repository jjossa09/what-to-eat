// Pure presentation and injected loading: no React Native, Supabase, or network imports.
import type { InsightCategory, InsightsResponse } from './api';

export type InsightBar = {
  id: string;
  label: string;
  value: number;
  budgetValue?: number;
  valueLabel: string;
};
export type InsightGroup = { id: string; label?: string; detail?: string; bars: InsightBar[] };
export type InsightCard = {
  groups: InsightGroup[];
  emptyText: string;
  note?: string;
  unavailable?: string;
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
    value: c.meal_count, valueLabel: String(c.meal_count),
  });
  const people = response.companions.companions;
  const missingNames = people.some((c) => !names.get(c.companion_id)?.trim());
  const includesBudgets = response.price_by_slot.some((s) => s.levels.some((l) => l.budget_count > 0));
  const cards: InsightCards = {
    top: { emptyText: EMPTY_TEXT.top,
      note: `${response.summary.category_meal_count} food meals`,
      groups: [{ id: 'top', bars: response.top_categories.map(categoryBar) }] },
    food: { emptyText: EMPTY_TEXT.food, groups: response.food_by_slot.map((s) => ({
      id: s.meal_slot, label: SLOT_LABELS[s.meal_slot], detail: `${s.category_meal_count} food meals`,
      bars: s.leaders.map(categoryBar),
    })) },
    price: { emptyText: EMPTY_TEXT.price, note: includesBudgets ? 'Includes budgets.' : undefined,
      groups: response.price_by_slot.filter((s) => s.levels.some((l) => l.paid_count || l.budget_count)).map((s) => ({
        id: s.meal_slot, label: SLOT_LABELS[s.meal_slot],
        detail: s.missing_meal_count ? `${s.missing_meal_count} missing` : undefined,
        bars: s.levels.map((l) => ({ id: String(l.level), label: '$'.repeat(l.level),
          value: l.paid_count, budgetValue: l.budget_count,
          valueLabel: `${l.paid_count} paid · ${l.budget_count} budget` })),
      })) },
    distance: { emptyText: EMPTY_TEXT.distance, note: 'Straight-line',
      groups: [{ id: 'distance', bars: response.distance_by_slot
        .filter((s) => s.median_m !== null).map((s) => ({
          id: s.meal_slot, label: SLOT_LABELS[s.meal_slot], value: s.median_m!,
          valueLabel: `${(s.median_m! / 1609.344).toFixed(1)} mi · ${s.measured_meal_count} meals`,
        })) }] },
    companions: { emptyText: EMPTY_TEXT.companions,
      unavailable: missingNames ? 'Names unavailable' : undefined,
      groups: missingNames ? [] : [{ id: 'companions', bars: people.map((c) => ({
        id: c.companion_id, label: names.get(c.companion_id)!,
        value: c.meal_count, valueLabel: String(c.meal_count),
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
