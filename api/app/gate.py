"""Confidence gate (P2-05, ML6, FR4) and the refinement question by information gain (ML10).

Pure functions, no I/O, no clock: the caller passes as_of. Muse never sees any of this; it only
parses answers. The question text is fixed in the app.

The gate asks three questions (FR4); company joins for with-people profiles with companions.
With four candidates it skips the strongest confident prediction, or company if all are weak.
Weak predictions are asked first; confident ones are asked last with their chip pre-selected
(editable). Ties keep the order craving, budget, distance. Weak = scoring.weak() (Starting
values: top probability under 0.4, or fewer than 5 meals in the context).
  craving:  the cuisine model (ML3) and scoring.is_weak.
  budget:   predict_budget() below, from what the user paid (meals.price_level).
  distance: always weak for now (no distance model; P2-03 revisits). Uniform in the gains.

Refinement (ML10 v2): after a round, the next question is the one whose answer would change
the next round's top 3 the most. For question Q with answers a, model probabilities P(a), and
the deterministic re-rank T(a) of the remaining candidates (the shown places dropped):
  IG(Q) = H(T) - E_a[H(T | a)] = H(T) = -sum over outcomes t of P(t) log2 P(t),
  P(t) = sum of P(a) over the answers a with T(a) = t.
H(T | a) is 0 because the re-rank is deterministic. Answers that lead to the same 3 places
merge, so a question that cannot change the picks gains 0. Highest gain wins, ties in the order
craving, budget, distance; when every gain is 0, the app keeps its fixed follow-up chips.

Constants are reused from app/scoring_rules.py (fixed, never tuned on the user's data).
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date
from uuid import UUID

from app.cuisine_model import PREDICTABLE, is_weekend, predict, recency_weight
from app.places import Candidate
from app.refine import RADII
from app.scoring import (
    Context,
    History,
    Models,
    PastMeal,
    Ranking,
    is_weak,
    rank,
    weak,
)
from app.scoring_rules import (
    LEVEL_MIN_N_EFF,
    QUIZ_FAVORITES_MASS,
    SCORE_DIGITS,
    SMOOTHING_K,
)

COMPANY = "company"

CRAVING, BUDGET, DISTANCE = "craving", "budget", "distance"
QUESTIONS: tuple[str, ...] = (CRAVING, BUDGET, DISTANCE)  # tie order
LEVELS: tuple[int, ...] = (1, 2, 3, 4)  # $ to $$$$
QUIZ, USER, SLOT, SLOT_WEEKEND, NONE = "quiz", "user", "slot", "slot_weekend", "none"
CRAVING_OPTIONS = 4  # chips shown for a refinement craving question (display only)
LOG_DIGITS = 4


# Budget model ----------------------------------------------------------------


@dataclass(frozen=True)
class LevelPrediction:
    """A probability per price level, and the raw meals behind the reported level."""

    probs: dict[int, float]  # every level, sums to 1
    meals: int
    level: str  # deepest level with n_eff >= LEVEL_MIN_N_EFF ("quiz" when none)


def budget_prior(quiz_level: int | None) -> dict[int, float]:
    """The quiz budget gets QUIZ_FAVORITES_MASS (as favorites do in ML3), the other levels
    share the rest. No quiz budget: uniform."""
    if quiz_level not in LEVELS:
        return dict.fromkeys(LEVELS, 1 / len(LEVELS))
    rest = (1 - QUIZ_FAVORITES_MASS) / (len(LEVELS) - 1)
    return {lvl: QUIZ_FAVORITES_MASS if lvl == quiz_level else rest for lvl in LEVELS}


def _smooth(weighted: dict[int, float], parent: dict[int, float]) -> dict[int, float]:
    n = sum(weighted.values())
    return {lvl: (weighted.get(lvl, 0.0) + SMOOTHING_K * parent[lvl]) / (n + SMOOTHING_K)
            for lvl in LEVELS}


def predict_budget(
    history: History, meal_slot: str, weekend: bool, as_of: date
) -> LevelPrediction:
    """What the user pays per meal (price tap, else backfill amount as a level), with the same
    recency weight, smoothing, and back-off as the cuisine model: quiz, user, slot,
    slot + weekday/weekend. Only meals before as_of count."""
    priced = [(m, recency_weight((as_of - m.eaten_on).days)) for m in history.meals
              if m.price_level in LEVELS and m.eaten_on < as_of]
    levels: tuple[tuple[str, Callable[[PastMeal], bool]], ...] = (
        (USER, lambda m: True),
        (SLOT, lambda m: m.meal_slot == meal_slot),
        (SLOT_WEEKEND, lambda m: m.meal_slot == meal_slot and is_weekend(m) == weekend),
    )
    probs = budget_prior(history.prior.budget_level)
    level, n_raw = QUIZ, 0
    for name, match in levels:
        weighted: dict[int, float] = {}
        raw = 0
        for m, w in priced:
            if match(m):
                weighted[m.price_level] = weighted.get(m.price_level, 0.0) + w
                raw += 1
        probs = _smooth(weighted, probs)
        if sum(weighted.values()) >= LEVEL_MIN_N_EFF:
            level, n_raw = name, raw
    return LevelPrediction(probs, n_raw, level)


# The 3 questions -------------------------------------------------------------


@dataclass(frozen=True)
class Question:
    key: str
    weak: bool
    predicted: str | int | list[str] | None  # the model's top answer (None: no prediction)
    top_prob: float
    meals: int  # raw meals behind the reported level
    level: str  # model level, "none" for distance

    @property
    def prefill(self) -> str | int | list[str] | None:
        """The pre-selected chip: only for a confident prediction (FR4)."""
        return None if self.weak else self.predicted

    def as_dict(self) -> dict:
        return {
            "key": self.key,
            "weak": self.weak,
            "prefill": self.prefill,
            "predicted": self.predicted,
            "top_prob": round(self.top_prob, LOG_DIGITS),
            "meals": self.meals,
            "level": self.level,
        }


@dataclass(frozen=True)
class Plan:
    questions: tuple[Question, ...]  # asking order
    skipped: Question | None = None

    @property
    def order(self) -> tuple[str, ...]:
        return tuple(q.key for q in self.questions)

    def as_log(self) -> dict:
        skipped = self.skipped.as_dict() if self.skipped else None
        if skipped and self.skipped.weak:
            skipped.update(predicted=None, reason="skipped_weak")
        return {"questions": [q.as_dict() for q in self.questions], "skipped": skipped}


def arrange(questions: tuple[Question, ...], *, new_search: bool = False) -> Plan:
    """Ask three; a new search reserves craving as its first answer."""
    skipped = None
    if len(questions) == 4:
        eligible = [q for q in questions if not (new_search and q.key == CRAVING)]
        confident = [q for q in eligible if not q.weak and not weak(q.top_prob, q.meals)]
        skipped = (max(confident, key=lambda q: (q.top_prob, q.key == BUDGET))
                   if confident else next(q for q in eligible if q.key == COMPANY))
    order = (*QUESTIONS, COMPANY)
    asked = sorted((q for q in questions if q is not skipped),
                   key=lambda q: (not (new_search and q.key == CRAVING),
                                  not q.weak, order.index(q.key)))
    if skipped and skipped.weak:
        skipped = replace(skipped, predicted=None)
    return Plan(tuple(asked), skipped)


def predict_company(history: History, meal_slot: str, weekend: bool, as_of: date) -> Question:
    """Fixed support across levels: solo plus observed, still-valid groups.

    Unknown company contributes to each level's denominator, but votes for no outcome.
    The resulting missing probability mass represents unknown company, not a guessed group.
    """
    observed = []
    groups = set()
    for m in history.meals:
        if m.eaten_on >= as_of:
            continue
        group = None
        if m.solo is True:
            group = "solo"
        elif m.companion_ids and m.companion_ids <= history.companions:
            group = tuple(sorted(m.companion_ids))
            groups.add(group)
        observed.append((m, group, recency_weight((as_of - m.eaten_on).days)))
    if not observed:
        return Question(COMPANY, True, None, 0.0, 0, NONE)
    outcomes = ["solo", *sorted(groups)]
    probs = dict.fromkeys(outcomes, 1 / len(outcomes))
    levels = ((USER, lambda m: True),
              (SLOT, lambda m: m.meal_slot == meal_slot),
              (SLOT_WEEKEND, lambda m: m.meal_slot == meal_slot and is_weekend(m) == weekend))
    level, meals = NONE, 0
    for name, match in levels:
        weighted = dict.fromkeys(outcomes, 0.0)
        raw, n = 0, 0.0
        for m, group, w in observed:
            if match(m):
                n += w
                raw += 1
                if group is not None:
                    weighted[group] += w
        probs = {g: (weighted[g] + SMOOTHING_K * probs[g]) / (n + SMOOTHING_K)
                 for g in outcomes}
        if n >= LEVEL_MIN_N_EFF:
            level, meals = name, raw
    if not any(group is not None for _, group, _ in observed):
        return Question(COMPANY, True, None, 0.0, meals, level)
    group, probability = _top(probs)
    predicted = group if group == "solo" else list(group)
    return Question(COMPANY, weak(probability, meals), predicted, probability, meals, level)


def model_context(meal_slot: str, weekend: bool, as_of: date) -> Context:
    """predict() reads only the meal slot and weekday/weekend (as scripts/evaluate.py does)."""
    return Context(lat=0.0, lon=0.0, local_date=as_of, meal_slot=meal_slot,
                   is_weekend=weekend, search_radius_m=0)


def _top(probs: dict) -> tuple[object, float]:
    """The first key with the highest probability (dict order breaks ties)."""
    key = max(probs, key=lambda k: probs[k])
    return key, probs[key]


def plan(
    history: History, meal_slot: str, weekend: bool, as_of: date, *, new_search: bool = False,
) -> Plan:
    """The 3 questions in asking order: weak first, then confident (pre-filled)."""
    cuisine = predict(history, model_context(meal_slot, weekend, as_of), as_of)
    category, p_cat = _top({c: cuisine.probs[c] for c in PREDICTABLE})
    craving = Question(CRAVING, is_weak(cuisine) or p_cat <= 0,
                       category if p_cat > 0 else None, p_cat, cuisine.meals, cuisine.level)
    price = predict_budget(history, meal_slot, weekend, as_of)
    lvl, p_lvl = _top(price.probs)
    budget = Question(BUDGET, weak(p_lvl, price.meals), lvl, p_lvl, price.meals, price.level)
    distance = Question(DISTANCE, True, None, 1 / len(RADII), 0, NONE)
    pool = (craving, budget, distance)
    if history.prior.mostly_solo is False and history.companions:
        pool += (predict_company(history, meal_slot, weekend, as_of),)
    return arrange(pool, new_search=new_search)


# Refinement question (ML10 v2) -----------------------------------------------


@dataclass(frozen=True)
class NextQuestion:
    key: str | None  # None: no question changes the picks; the app keeps its fixed chips
    options: tuple[str | int, ...]  # answer chips, best first
    gains: dict[str, float]  # bits, every question

    def as_dict(self) -> dict | None:
        if self.key is None:
            return None
        return {"key": self.key, "options": list(self.options), "gains": self.gains}

    def as_log(self) -> dict:
        return {"key": self.key, "options": list(self.options), "gains": self.gains}


def entropy(outcomes: list[tuple[float, frozenset[str]]]) -> float:
    """H of the top-3 outcomes, answers with the same outcome merged. Bits, rounded."""
    merged: dict[frozenset[str], float] = {}
    for p, top3 in outcomes:
        merged[top3] = merged.get(top3, 0.0) + p
    total = sum(merged.values())
    if total <= 0:
        return 0.0
    h = -sum((p / total) * math.log2(p / total) for p in merged.values() if p > 0)
    return max(0.0, round(h, SCORE_DIGITS))


def choose(gains: dict[str, float]) -> str | None:
    """Highest gain; ties keep the order craving, budget, distance. None when all are 0."""
    key: str | None = None
    for q in QUESTIONS:  # strictly greater, so ties keep the earlier question
        if gains.get(q, 0.0) > 0 and (key is None or gains[q] > gains[key]):
            key = q
    return key


def next_question(
    ranking: Ranking,
    context: Context,
    history: History,
    merged_ids: frozenset[str],
    models: Models,
    budget: LevelPrediction,
) -> NextQuestion:
    """The refinement question with the highest information gain over the next round's top 3.

    Candidates are this round's ranked places minus the 3 just shown (the next round skips
    them). No places search and no Muse call: every re-rank uses the same models.
    """
    shown = frozenset(p.scored.place.id for p in ranking.top3)
    remaining = [s.place for s in ranking.ranked if s.place.id not in shown]
    base = replace(context, exclude_ids=context.exclude_ids | shown)

    def top3(ctx: Context, cands: list[Candidate] = remaining) -> frozenset[str]:
        return frozenset(p.scored.place.id for p in
                         rank(cands, ctx, history, merged_ids, models).top3)

    # Craving: the cuisine model's probabilities over the categories still allowed.
    probs = models.prediction.probs
    allowed = [c for c in PREDICTABLE if probs.get(c, 0.0) > 0
               and c not in history.prior.hard_nos and c not in context.exclude_categories]
    mass = sum(probs[c] for c in allowed)
    present = {c.category for c in remaining}
    craving_out: list[tuple[float, frozenset[str]]] = []
    if mass > 0 and remaining:
        craving_out = [(probs[c] / mass, top3(replace(base, craving=c)))
                       for c in allowed if c in present]
        absent = [c for c in allowed if c not in present]
        if absent:
            # A craving no candidate has scales every category fit by the same factor and
            # leaves no familiar match, so every absent category gives the same top 3.
            craving_out.append((sum(probs[c] for c in absent) / mass,
                                top3(replace(base, craving=absent[0]))))

    budget_out = ([(budget.probs[lvl], top3(replace(base, budget_level=lvl))) for lvl in LEVELS]
                  if remaining else [])
    distance_out = ([(1 / len(RADII), top3(replace(base, radius_m=r),
                                           [c for c in remaining if c.distance_m <= r]))
                     for r in RADII] if remaining else [])

    gains = {CRAVING: entropy(craving_out), BUDGET: entropy(budget_out),
             DISTANCE: entropy(distance_out)}
    key = choose(gains)
    if key == CRAVING:
        ordered = sorted((c for c in allowed if c in present),
                         key=lambda c: (-probs[c], PREDICTABLE.index(c)))
        options: tuple[str | int, ...] = tuple(ordered[:CRAVING_OPTIONS])
    elif key == BUDGET:
        options = LEVELS
    elif key == DISTANCE:
        options = RADII
    else:
        options = ()
    return NextQuestion(key, options, gains)


# The cap round (ML10): after 3 rounds without a pick, the open question, by rule, not by gain.
CAP_ENTRY: dict = {"key": "open", "rule": "cap"}


# What the phone asked (round 1): its order and where it came from. plan: the gate's plan;
# fallback: the default order (no usable plan); new_search: a search started after a pick,
# craving first because the typed text is the craving, then the session's order.
PLAN_SOURCES = ("plan", "fallback", "new_search")
OK, MISSING, INVALID = "ok", "missing", "invalid"


def asked_log(order: object, source: object, recomputed: Plan) -> dict:
    """The phone's question order and plan source, checked, next to the recomputed plan.

    Valid order: three distinct keys from the recomputed pool. Valid source: one of
    PLAN_SOURCES. Neither sent (an older app): missing. Anything else: invalid; a bad value is
    never logged as given, only as None. matches_plan compares a valid order with the plan
    the server recomputed now (it can differ after a fallback or a meal slot change).
    """
    keys = order if isinstance(order, list) else None
    pool = {q.key for q in recomputed.questions}
    if recomputed.skipped:
        pool.add(recomputed.skipped.key)
    valid_order = (keys is not None and len(keys) == 3
                   and all(isinstance(k, str) for k in keys)
                   and len(set(keys)) == 3 and set(keys) <= pool)
    valid_source = isinstance(source, str) and source in PLAN_SOURCES
    if order is None and source is None:
        status = MISSING
    elif valid_order and valid_source:
        status = OK
    else:
        status = INVALID
    return {
        "status": status,
        "order": list(keys) if valid_order else None,
        "source": source if valid_source else None,
        "matches_plan": list(recomputed.order) == keys if valid_order else None,
    }


# Trace (round 1): the pre-fills the phone received and the chips it highlighted.
PREFILL_SETS = ("received", "shown")


def _prefill_value(key: str, value: object) -> bool:
    """A pre-fill a chip can hold: a category id, a level 1-4, a radius chip, or None."""
    if value is None:
        return True
    if key == CRAVING:
        return isinstance(value, str) and value in PREDICTABLE
    if key == BUDGET:
        return isinstance(value, int) and not isinstance(value, bool) and value in LEVELS
    return isinstance(value, int) and not isinstance(value, bool) and value in RADII


def prefilled_log(value: object) -> dict:
    """The phone's pre-fill trace, checked. Valid: {"received": {...}, "shown": {...}}, each
    with exactly the keys craving, budget, distance, values a chip can hold or None. Not sent:
    missing. Anything else: invalid, and nothing of it is logged."""
    if value is None:
        return {"status": MISSING, "received": None, "shown": None}
    ok = (isinstance(value, dict) and set(value) == set(PREFILL_SETS)
          and all(isinstance(value[s], dict) and set(value[s]) == set(QUESTIONS)
                  and all(_prefill_value(k, v) for k, v in value[s].items())
                  for s in PREFILL_SETS))
    if not ok:
        return {"status": INVALID, "received": None, "shown": None}
    return {"status": OK, **{s: {k: value[s][k] for k in QUESTIONS} for s in PREFILL_SETS}}


def company_prefilled_log(value: object) -> dict:
    """Separate optional company trace. Invalid telemetry never rejects the round."""
    empty = {"received": None, "shown": None}
    if not isinstance(value, dict) or set(value) != set(PREFILL_SETS):
        return {"status": INVALID, **empty}
    cleaned = {}
    for key in PREFILL_SETS:
        item = value[key]
        if item is None or item == "solo":
            cleaned[key] = item
        elif isinstance(item, list) and all(isinstance(v, str) for v in item):
            try:
                ids = [str(UUID(v)) for v in item]
            except ValueError:
                return {"status": INVALID, **empty}
            if len(set(ids)) != len(ids):
                return {"status": INVALID, **empty}
            cleaned[key] = ids
        else:
            return {"status": INVALID, **empty}
    return {"status": OK, **cleaned}
