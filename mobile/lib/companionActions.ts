import type { InsightsResponse, Place } from './api';
import { companionCall, deviceTimezone } from './api';
import { companionIds, resolveDate, validMealDate, type ChartId, type Intent, type Person, type Slot } from './companion';

export type Profile = { favorite_categories: string[]; hard_no_categories: string[];
  budget_level: number; mostly_solo: boolean; updated_at: string };
export type ProfileDraft = { favorites: string[]; hard_nos: string[]; budget: number;
  mostly_solo: boolean; expected_updated_at: string; source: 'chat' | 'profile' };
export type MealRecord = { id: string; revision: number; source: 'live' | 'backfill' | 'chat';
  eaten_on: string; meal_slot: Slot | null; category_id: string | null; dish: string | null;
  went: boolean | null; ate_at: string | null; stars: number | null; solo: boolean | null;
  meal_companions: { companion_id: string }[]; places: { id: string; name: string; unresolved: boolean } | null };
export type MealDraft = { category_id: string; eaten_on: string; timezone: string; meal_slot: Slot | null;
  dish: string; place_id: string | null; companion_ids: string[]; solo: boolean | null;
  stars: number | null; allow_duplicate: boolean };
export type Pending = { key: string; kind: 'log_meal' | 'rate_meal' | 'preference_change';
  arguments: MealDraft | ProfileDraft | { meal_id: string; revision: number; changes: { stars: number | null } };
  placeName?: string; second?: string; dateHint?: string; savedId?: string };
export type HistoryResult = { stats: InsightsResponse; chart_id: ChartId; from_date: string;
  to_date: string; line: string; note: string | null };
export type NearbyResult = { places: Place[]; widened: boolean; truncated: boolean };
export type Output = { kind: 'history'; data: HistoryResult } | { kind: 'nearby'; data: NearbyResult };

export function profileDraft(profile: Profile, source: 'chat' | 'profile'): ProfileDraft {
  return { favorites: [...profile.favorite_categories], hard_nos: [...profile.hard_no_categories],
    budget: profile.budget_level, mostly_solo: profile.mostly_solo,
    expected_updated_at: profile.updated_at, source };
}
export function changePreference(profile: Profile, intent: Extract<Intent, { type: 'preference_change' }>): ProfileDraft {
  const draft = profileDraft(profile, 'chat');
  const category = intent.category;
  if (intent.operation === 'remove_favorite') draft.favorites = draft.favorites.filter((c) => c !== category);
  if (intent.operation === 'add_favorite') {
    draft.favorites = [...new Set([...draft.favorites, category])];
    draft.hard_nos = draft.hard_nos.filter((c) => c !== category);
  }
  if (intent.operation === 'add_hard_no') {
    draft.hard_nos = [...new Set([...draft.hard_nos, category])];
    draft.favorites = draft.favorites.filter((c) => c !== category);
  }
  if (intent.operation === 'remove_hard_no') draft.hard_nos = draft.hard_nos.filter((c) => c !== category);
  return draft;
}
export function draftMeal(intent: Extract<Intent, { type: 'log_meal' }>, people: readonly Person[]): MealDraft {
  return { category_id: intent.category ?? '', eaten_on: resolveDate(intent.date) ?? '',
    timezone: deviceTimezone() ?? '', meal_slot: intent.slot, dish: intent.dish ?? '', place_id: null,
    companion_ids: companionIds(intent.company, people) ?? [], solo: intent.solo,
    stars: intent.stars, allow_duplicate: false };
}

export function enrichMeal(pending: Pending, intent: Extract<Intent, { type: 'log_meal' }>, people: readonly Person[], invalidDate = false): Pending {
  const before = pending.arguments as MealDraft;
  const update = draftMeal(intent, people);
  const arguments_ = { ...before, allow_duplicate: false,
    ...(intent.category !== null ? { category_id: update.category_id } : {}),
    ...(invalidDate ? { eaten_on: '' } : intent.date !== null ? { eaten_on: update.eaten_on } : {}),
    ...(intent.slot !== null ? { meal_slot: update.meal_slot } : {}),
    ...(intent.dish !== null ? { dish: update.dish } : {}),
    ...(intent.stars !== null ? { stars: update.stars } : {}),
    ...(intent.solo !== null || intent.company.length ? { solo: update.solo, companion_ids: update.companion_ids } : {}),
    ...(intent.place_name ? { place_id: null } : {}),
  };
  return { ...pending, arguments: arguments_,
    ...(intent.place_name ? { placeName: undefined } : {}),
    ...(intent.date ? { dateHint: intent.date.kind === 'weekday' ? 'Which date did you mean?' : undefined } : {}),
  };
}

export function missingMealLine(meal: MealDraft): string | null {
  if (!meal.category_id) return meal.dish ? 'Which food category was it?' : 'Sure! What did you eat?';
  if (!meal.eaten_on) return 'When did you eat it?';
  if (!validMealDate(meal.eaten_on)) return 'Choose a valid date on or before today.';
  return null;
}

export function lookupFailureLine(error: unknown): string {
  const e = error as { code?: string; message?: string; kind?: string } | null;
  if (e?.kind === 'auth') return 'Please sign in again.';
  const code = e?.code ?? e?.message;
  if (code === 'lookup_location') return 'Location is unavailable; you can save without a restaurant.';
  if (code === 'lookup_timeout' || code?.toLowerCase().includes('timeout')) return 'Place lookup timed out; retry or save without a restaurant.';
  if (code === 'lookup_invalid_response') return 'Place data was invalid; retry or save without a restaurant.';
  return 'Place lookup failed; retry or save without a restaurant.';
}

const namedCache = new Map<string, NearbyResult>();
export async function nearby(name: string, position: { lat: number; lon: number }, radius: number | null) {
  const path = `/places/search?name=${encodeURIComponent(name)}&lat=${position.lat}&lng=${position.lon}${radius === null ? '' : `&radius_m=${radius}`}`;
  const cached = namedCache.get(path);
  if (cached) return cached;
  const result = await companionCall<NearbyResult>(path);
  namedCache.set(path, result);
  if (namedCache.size > 20) namedCache.delete(namedCache.keys().next().value!);
  return result;
}

export async function persistPending(pending: Pending, conversationId: string) {
  const prepared = await companionCall<{ id: string; arguments: Record<string, unknown>; state: string }>(
    '/conversation/actions/prepare', { conversation_id: conversationId, client_key: pending.key,
      kind: pending.kind, arguments: pending.arguments });
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).filter((k) => object[k] != null).sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  if (canonical(prepared.arguments) !== canonical(pending.arguments)) throw new Error('Action changed; reopen it');
  // Server echoes the validated payload that the confirmation actually persists.
  return { prepared, save: async () => {
    const result = await companionCall<{ status: 'saved' | 'duplicate'; meal_id?: string }>(
    '/conversation/actions/confirm', { conversation_id: conversationId, action_id: prepared.id,
      arguments: prepared.arguments, confirmed: true });
    if (!result || !['saved', 'duplicate'].includes(result.status)) throw new Error('Save was not confirmed');
    return result;
  } };
}
