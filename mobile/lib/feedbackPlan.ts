// Which "Went?" steps are still open for a live pick (P1-17, P1-24). Pure, no imports, so it
// runs under `node --test`. An answer given anywhere (the prompt, an auto-detected visit, or
// the meal card's Edit) is never asked again.

export type MealAnswers = {
  went: boolean | null;
  ateAnswered: boolean; // ate_at set: "What did you have?" was answered
  stars: number | null;
  priceTap: number | null;
};

export type ResumePlan =
  | { kind: 'none' } // nothing left to ask
  | { kind: 'went' } // "Did you go?" (or a likely visit)
  | { kind: 'food'; askPrice: boolean }
  | { kind: 'stars'; askPrice: boolean };

export function resumePlan(a: MealAnswers): ResumePlan {
  if (a.went === null) return { kind: 'went' };
  // Went = false, or rated: done. A skipped price is never asked again.
  if (a.went === false || a.stars !== null) return { kind: 'none' };
  const askPrice = a.priceTap === null;
  return a.ateAnswered ? { kind: 'stars', askPrice } : { kind: 'food', askPrice };
}
