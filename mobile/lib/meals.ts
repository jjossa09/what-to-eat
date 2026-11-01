import { supabase } from './supabase';

// Meals tab and Profile "Most eaten" (P1-22), and the meal detail card (P1-24). Read under
// existing RLS (own meals, own and shared places, own companions). Edits go through the
// edit_meal() database function; meals has no update policy.

export type Meal = {
  id: string;
  source: 'backfill' | 'live';
  category: string | null;
  placeName: string;
  eatenOn: string; // local date, YYYY-MM-DD
  mealSlot: 'breakfast' | 'lunch' | 'dinner' | 'late' | null;
  stars: number | null;
  went: boolean | null;
  pickedAt: string | null; // live: when it was picked (the card's time)
  dish: string | null;
  ateAnswered: boolean; // "What did you have?" answered (ate_at set)
  solo: boolean | null;
  companions: string[]; // names from meal_companions (backfill for now)
  priceTap: number | null;
  priceLevel: number | null; // the tap, else the backfill amount as a level
  priceAmount: number | null; // backfill, USD
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
  picked_at: string | null;
  dish: string | null;
  ate_at: string | null;
  solo: boolean | null;
  price_tap: number | null;
  price_level: number | null;
  price_amount: number | string | null; // numeric comes back as a string
  places: { name: string; category_id: string | null } | null;
  meal_companions: { companions: { name: string } | null }[] | null;
};

const COLUMNS =
  'id,source,category_id,eaten_on,meal_slot,stars,went,picked_at,dish,ate_at,solo,price_tap,' +
  'price_level,price_amount,places(name,category_id),meal_companions(companions(name))';

/** Newest first. Live picks the user said they skipped (went = false) are hidden. */
export async function loadMeals(userId: string): Promise<Meal[]> {
  const { data, error } = await supabase
    .from('meals')
    .select(COLUMNS)
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
    pickedAt: r.picked_at,
    dish: r.dish,
    ateAnswered: r.ate_at !== null,
    solo: r.solo,
    companions: (r.meal_companions ?? []).flatMap((c) => (c.companions ? [c.companions.name] : [])),
    priceTap: r.price_tap,
    priceLevel: r.price_level,
    priceAmount: r.price_amount === null ? null : Number(r.price_amount),
  }));
}

/** The card's Edit: live meals with went = true (the database checks the same rule). */
export function canEdit(meal: Meal): boolean {
  return meal.source === 'live' && meal.went === true;
}

export type MealEdit = { dish?: string; stars?: number; priceTap?: number; solo?: boolean };

/** Only changed fields; a blank dish clears it. Each change is logged as an edited event. */
export async function editMeal(mealId: string, edit: MealEdit): Promise<void> {
  const { error } = await supabase.rpc('edit_meal', {
    p_meal_id: mealId,
    ...(edit.dish !== undefined ? { p_dish: edit.dish } : {}),
    ...(edit.stars !== undefined ? { p_stars: edit.stars } : {}),
    ...(edit.priceTap !== undefined ? { p_price_tap: edit.priceTap } : {}),
    ...(edit.solo !== undefined ? { p_solo: edit.solo } : {}),
  });
  if (error) throw error;
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
  late: 'Late night', // 21:00 to 04:59; after midnight counts on the previous day
};

export function slotLabel(slot: Meal['mealSlot']): string | null {
  return slot ? SLOT_LABELS[slot] : null;
}

function localDate(eatenOn: string): Date {
  const [y, m, d] = eatenOn.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Oct 31 · 11:58 PM" (live, with the pick time), else "Oct 31". */
export function mealWhen(meal: Meal): string {
  const date = localDate(meal.eatenOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!meal.pickedAt) return date;
  const time = new Date(meal.pickedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

/** "Oct 29 · Dinner", or "Oct 29" when the slot is unknown. */
export function mealLine(meal: Meal): string {
  const date = localDate(meal.eatenOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return meal.mealSlot ? `${date} · ${SLOT_LABELS[meal.mealSlot]}` : date;
}
