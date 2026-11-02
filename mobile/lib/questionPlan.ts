// The confidence gate's pre-fills on the phone (P2-05, FR4). Pure, no imports, so it runs under
// `node --test`. The plan's prefill values are the same ids the chips use: a category id for
// craving, a level 1-4 for budget, a radius for distance.

export type Radius = 15000 | 35000;
export const RADII: readonly Radius[] = [15000, 35000];

/** Pre-selected chips. A missing key means no pre-selection from this source. */
export type Prefill = { craving?: string; budget?: number; radius?: Radius };

/** The part of a plan question this reads; prefill is unknown until checked. */
export type PlanQuestionShape = { key: string; prefill: unknown };

function isRadius(value: unknown): value is Radius {
  return RADII.some((r) => r === value);
}

/** The plan's pre-fills, kept only when they match a chip: a known category id, a level 1-4,
 * or a radius chip. Anything else is dropped (never guessed). */
export function planPrefill(
  questions: readonly PlanQuestionShape[] | undefined,
  categoryIds: ReadonlySet<string>,
): Prefill {
  const pre: Prefill = {};
  for (const q of questions ?? []) {
    const v = q.prefill;
    if (q.key === 'craving' && typeof v === 'string' && categoryIds.has(v)) pre.craving = v;
    if (q.key === 'budget' && typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 4) pre.budget = v;
    if (q.key === 'distance' && isRadius(v)) pre.radius = v;
  }
  return pre;
}

/** The selected budget chip: the pre-fill, else the user's quiz budget (their own answer). */
export function budgetPick(preset: Prefill, quizBudget: number | null | undefined): number | null {
  return preset.budget ?? quizBudget ?? null;
}

/** The pre-selections as the trace sends them (P2-05): every question, null when none. */
export type PrefillTrace = { craving: string | null; budget: number | null; distance: Radius | null };

export function traceOf(p: Prefill): PrefillTrace {
  return { craving: p.craving ?? null, budget: p.budget ?? null, distance: p.radius ?? null };
}
