import { getPositionIfAllowed } from './location';
import { distanceM } from './places';
import { supabase } from './supabase';

// Went? + stars + price tap (P1-17, FR11). One place for the timing and distance rules, so they
// can be shortened for a demo.
export const MAX_DISH = 60;

export const FEEDBACK_CONFIG = {
  likelyVisitRadiusM: 250, // FR11: this close to the picked place counts as a likely visit...
  likelyVisitWindowH: 4, // ...between pick time and pick + 4 h
  askAfterH: 1, // otherwise ask "Did you go?" no sooner than this after the pick...
  askUntilH: 48, // ...and no later than this
  notifyAfterH: 2, // FR10 (P1-16): the reminder fires this long after the app last went to the background
};

const HOUR_MS = 3_600_000;

export type PendingMeal = {
  id: string;
  placeName: string;
  pickedAt: Date;
  categoryId: string | null; // the place's category at pick time; pre-selects "What did you have?"
};

/**
 * What to do on app open: nothing, ask "Did you go?", an auto-detected visit, or resume a meal
 * that has went = true: at "What did you have?" (no food answer yet) or "How was it?" (food
 * answered, no stars yet).
 */
export type FeedbackStart =
  | { kind: 'none' }
  | { kind: 'ask'; meal: PendingMeal }
  | { kind: 'likely'; meal: PendingMeal }
  | { kind: 'resumeFood'; meal: PendingMeal }
  | { kind: 'resumeStars'; meal: PendingMeal };

type Row = {
  id: string;
  picked_at: string;
  went: boolean | null;
  category_id: string | null;
  ate_at: string | null;
  places: { name: string; lat: number | null; lon: number | null } | null;
};

type Pending = {
  meal: PendingMeal;
  went: boolean | null;
  ateAnswered: boolean;
  lat: number | null;
  lon: number | null;
};

/**
 * The latest live pick still waiting for an answer, read under RLS: went = null, or went = true
 * with no stars yet (the flow was left before rating). A skipped price is never asked again.
 */
async function latestPending(userId: string): Promise<Pending | null> {
  const { data, error } = await supabase
    .from('meals')
    .select('id,picked_at,went,category_id,ate_at,places(name,lat,lon)')
    .eq('user_id', userId)
    .eq('source', 'live')
    .or('went.is.null,and(went.eq.true,stars.is.null)')
    .not('picked_at', 'is', null)
    .order('picked_at', { ascending: false })
    .limit(1)
    .returns<Row[]>();
  if (error) throw error;
  const row = data?.[0];
  if (!row || !row.places) return null;
  return {
    meal: {
      id: row.id,
      placeName: row.places.name,
      pickedAt: new Date(row.picked_at),
      categoryId: row.category_id,
    },
    went: row.went,
    ateAnswered: row.ate_at !== null,
    lat: row.places.lat,
    lon: row.places.lon,
  };
}

/** The latest live pick with no "Did you go?" answer yet (went = null), for the reminder (P1-16). */
export async function pendingPick(userId: string): Promise<PendingMeal | null> {
  const pending = await latestPending(userId);
  return pending && pending.went === null ? pending.meal : null;
}

/**
 * FR11 on app open: a likely visit (near, in the window), a question, or nothing. Also returns
 * the unanswered pick (went = null, inside the 48 h window), so the reminder cache stays current.
 */
export async function checkFeedback(
  userId: string,
  now: Date = new Date(),
): Promise<{ start: FeedbackStart; unanswered: PendingMeal | null }> {
  const pending = await latestPending(userId);
  if (!pending) return { start: { kind: 'none' }, unanswered: null };
  const ageH = (now.getTime() - pending.meal.pickedAt.getTime()) / HOUR_MS;
  if (ageH < 0 || ageH > FEEDBACK_CONFIG.askUntilH) return { start: { kind: 'none' }, unanswered: null };
  return { start: await startFor(pending, ageH), unanswered: pending.went === null ? pending.meal : null };
}

async function startFor(pending: Pending, ageH: number): Promise<FeedbackStart> {
  if (pending.went === true) {
    return { kind: pending.ateAnswered ? 'resumeStars' : 'resumeFood', meal: pending.meal };
  }

  if (ageH <= FEEDBACK_CONFIG.likelyVisitWindowH && pending.lat !== null && pending.lon !== null) {
    const here = await getPositionIfAllowed();
    if (here && distanceM(here, { lat: pending.lat, lon: pending.lon }) <= FEEDBACK_CONFIG.likelyVisitRadiusM) {
      return { kind: 'likely', meal: pending.meal };
    }
  }
  return ageH >= FEEDBACK_CONFIG.askAfterH ? { kind: 'ask', meal: pending.meal } : { kind: 'none' };
}

/** One answer per call; the database function checks the order and logs the funnel event. */
export async function saveFeedback(
  mealId: string,
  answer:
    | { went: boolean }
    | { category: string; dish: string | null }
    | { stars: number }
    | { priceTap: number },
): Promise<void> {
  const { error } = await supabase.rpc('save_meal_feedback', {
    p_meal_id: mealId,
    ...('went' in answer ? { p_went: answer.went } : {}),
    ...('category' in answer ? { p_category: answer.category, p_dish: answer.dish } : {}),
    ...('stars' in answer ? { p_stars: answer.stars } : {}),
    ...('priceTap' in answer ? { p_price_tap: answer.priceTap } : {}),
  });
  if (error) throw error;
}
