// Which "Went?" steps are still open for a live pick (P1-17, P1-24, P2-06). Pure, no imports, so
// it runs under `node --test`. An answer given anywhere (the prompt, an auto-detected visit, or
// the meal card's Edit) is never asked again. The food answer is always asked while it is
// missing (the cuisine model counts a live meal only with it), even after stars or a price.

export type MealAnswers = {
  went: boolean | null;
  ateAnswered: boolean; // ate_at set: "What did you have?" was answered
  stars: number | null;
  priceTap: number | null;
};

export type ResumePlan =
  | { kind: 'none' } // nothing left to ask
  | { kind: 'went' } // "Did you go?" (or a likely visit)
  | { kind: 'food'; askStars: boolean; askPrice: boolean }
  | { kind: 'stars'; askPrice: boolean };

export function resumePlan(a: MealAnswers): ResumePlan {
  if (a.went === null) return { kind: 'went' };
  if (a.went === false) return { kind: 'none' };
  // The price follows stars; once rated, a skipped price is never asked again.
  const askStars = a.stars === null;
  const askPrice = askStars && a.priceTap === null;
  if (!a.ateAnswered) return { kind: 'food', askStars, askPrice };
  return askStars ? { kind: 'stars', askPrice } : { kind: 'none' };
}
