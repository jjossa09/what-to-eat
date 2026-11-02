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


export type CompanySelection = 'solo' | string[] | null;

/** Only known companion IDs can preselect chips or become a skipped answer. */
export function companySelection(value: unknown, ids: ReadonlySet<string>): CompanySelection {
  if (value === 'solo') return value;
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length) return null;
  return value.every((id) => typeof id === 'string' && ids.has(id)) ? [...value].sort() : null;
}

/** Exact names, case-insensitive; ambiguous names or unmatched text never guess a group. */
export function matchCompany(
  text: string,
  companions: readonly { id: string; name: string }[],
): CompanySelection {
  const normalized = text.trim().toLocaleLowerCase();
  if (['solo', 'alone', 'just me'].includes(normalized)) return 'solo';
  const exact = companions.filter((c) => c.name.trim().toLocaleLowerCase() === normalized);
  if (exact.length) return exact.length === 1 ? [exact[0].id] : null;
  const parts = normalized.split(/\s*(?:,|&|\band\b)\s*/);
  const ids: string[] = [];
  for (const part of parts) {
    const matches = companions.filter((c) => c.name.trim().toLocaleLowerCase() === part);
    if (matches.length !== 1 || ids.includes(matches[0].id)) return null;
    ids.push(matches[0].id);
  }
  return ids.length ? ids.sort() : null;
}


export type SkippedQuestionShape = { key: string; weak: boolean; predicted: unknown };

/** A skipped weak answer is unknown, even if an older server sent a prediction. */
export function skippedAnswers(
  skipped: SkippedQuestionShape | null | undefined,
  categoryIds: ReadonlySet<string>,
  companionIds: ReadonlySet<string>,
): Prefill & { company?: CompanySelection } {
  if (!skipped || skipped.weak !== false) return {};
  if (skipped.key === 'company') {
    return { company: companySelection(skipped.predicted, companionIds) };
  }
  return planPrefill([{ key: skipped.key, prefill: skipped.predicted }], categoryIds);
}

type NewSearchQuestion = SkippedQuestionShape & {
  prefill: unknown; top_prob: number; meals: number;
};

/** Mirrors gate.arrange(new_search=True): craving plus two, with the same ML6 skip rule. */
export function newSearchPlan<T extends NewSearchQuestion>(plan: {
  questions: readonly T[]; skipped: T | null;
}): { questions: T[]; skipped: T | null } {
  const order = ['craving', 'budget', 'distance', 'company'];
  const pool = [...plan.questions, ...(plan.skipped ? [plan.skipped] : [])]
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  // A server plan that already includes craving has already made the same skip decision.
  // Preserve it: top_prob in the response is rounded and could otherwise create a false tie.
  let skipped: T | null = plan.skipped?.key === 'craving' ? null : plan.skipped;
  if (pool.length === 4 && plan.skipped?.key === 'craving') {
    const confident = pool.filter((q) => q.key !== 'craving' && !q.weak
      && q.top_prob >= 0.4 && q.meals >= 5);
    confident.sort((a, b) => b.top_prob - a.top_prob
      || Number(b.key === 'budget') - Number(a.key === 'budget'));
    skipped = confident[0] ?? pool.find((q) => q.key === 'company') ?? null;
  }
  const questions = pool.filter((q) => q !== skipped).sort((a, b) =>
    Number(b.key === 'craving') - Number(a.key === 'craving')
    || Number(b.weak) - Number(a.weak) || order.indexOf(a.key) - order.indexOf(b.key));
  if (skipped?.weak) {
    skipped = { ...skipped, predicted: null, prefill: null, reason: 'skipped_weak' };
  }
  return { questions, skipped };
}
