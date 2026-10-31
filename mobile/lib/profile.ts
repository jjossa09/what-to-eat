import { supabase } from './supabase';

export type Category = { id: string; name: string };

export type QuizAnswers = {
  favorites: string[];
  hardNos: string[];
  budget: 1 | 2 | 3 | 4;
  mostlySolo: boolean;
  companions: string[];
};

export const MAX_FAVORITES = 5;

/** True if the signed-in user already has a taste profile (RLS returns only their row). */
export async function hasTasteProfile(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('taste_profiles')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

export type TastePrior = {
  favorites: string[];
  budget: QuizAnswers['budget'] | null;
  mostlySolo: boolean | null;
};

/** The quiz prior used to order and pre-fill the chat questions (FR4 cold start). */
export async function loadTastePrior(userId: string): Promise<TastePrior> {
  const { data, error } = await supabase
    .from('taste_profiles')
    .select('favorite_categories,budget_level,mostly_solo')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const budget = data?.budget_level;
  return {
    favorites: data?.favorite_categories ?? [],
    budget: budget >= 1 && budget <= 4 ? (budget as QuizAnswers['budget']) : null,
    mostlySolo: data?.mostly_solo ?? null,
  };
}

/** The ML2 categories a user can pick (Other is never a quiz answer). */
export async function loadCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id,name')
    .eq('predictable', true)
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

/** Saves the quiz in one transaction. The database function validates every answer. */
export async function saveTasteQuiz(answers: QuizAnswers): Promise<void> {
  const { error } = await supabase.rpc('save_taste_quiz', {
    p_favorites: answers.favorites,
    p_hard_nos: answers.hardNos,
    p_budget: answers.budget,
    p_mostly_solo: answers.mostlySolo,
    p_companions: answers.mostlySolo ? [] : answers.companions,
  });
  if (error) throw error;
}
