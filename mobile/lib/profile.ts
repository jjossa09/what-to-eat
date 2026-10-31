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
