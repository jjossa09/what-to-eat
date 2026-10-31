import { supabase } from './supabase';

// Meals tab and Profile "Most eaten" (P1-22). Read under existing RLS (own meals, own and
// shared places).

export type Meal = {
  id: string;
  source: 'backfill' | 'live';
  category: string | null;
  placeName: string;
  eatenOn: string; // local date, YYYY-MM-DD
  mealSlot: 'breakfast' | 'lunch' | 'dinner' | 'late' | null;
  stars: number | null;
  went: boolean | null;
};

const MEALS_LIMIT = 200;

type Row = {
  id: string;
  source: Meal['source'];
  category_id: string | null;
  eaten_on: string;
  meal_slot: Meal['mealSlot'];
  stars: number | null;
  went: boolean | null;
  places: { name: string; category_id: string | null } | null;
};

/** Newest first. Live picks the user said they skipped (went = false) are hidden. */
export async function loadMeals(userId: string): Promise<Meal[]> {
  const { data, error } = await supabase
    .from('meals')
    .select('id,source,category_id,eaten_on,meal_slot,stars,went,places(name,category_id)')
    .eq('user_id', userId)
    .or('went.is.null,went.eq.true')
    .order('eaten_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(MEALS_LIMIT)
    .returns<Row[]>();
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    source: r.source,
    category: r.category_id ?? r.places?.category_id ?? null,
    placeName: r.places?.name ?? 'Unknown place',
    eatenOn: r.eaten_on,
    mealSlot: r.meal_slot,
    stars: r.stars,
    went: r.went,
  }));
}

/**
 * The category eaten most, counting the meals the scoring counts (backfill, or live with
 * went = true). Ties go to the most recent. Null when there are none.
 */
export function mostEatenCategory(meals: Meal[]): string | null {
  const counts = new Map<string, { n: number; firstIndex: number }>();
  meals.forEach((m, i) => {
    const counted = m.source === 'backfill' || m.went === true;
    if (!counted || !m.category || m.category === 'other') return;
    const entry = counts.get(m.category);
    if (entry) entry.n += 1;
    else counts.set(m.category, { n: 1, firstIndex: i });
  });
  let best: string | null = null;
  let bestEntry: { n: number; firstIndex: number } | null = null;
  for (const [category, entry] of counts) {
    if (!bestEntry || entry.n > bestEntry.n || (entry.n === bestEntry.n && entry.firstIndex < bestEntry.firstIndex)) {
      best = category;
      bestEntry = entry;
    }
  }
  return best;
}

const SLOT_LABELS: Record<NonNullable<Meal['mealSlot']>, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  late: 'Late',
};

/** "Oct 29 · Dinner", or "Oct 29" when the slot is unknown. */
export function mealLine(meal: Meal): string {
  const [y, m, d] = meal.eatenOn.split('-').map(Number);
  const date = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return meal.mealSlot ? `${date} · ${SLOT_LABELS[meal.mealSlot]}` : date;
}
