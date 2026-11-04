"""Deterministic scoring v1 (P1-12, FR7, ML5): candidates + context + history -> top 3.

Pure functions, no I/O, no clock: the caller passes the local date. Weights and thresholds
are in app/scoring_rules.py. Muse never touches this; it only words the evidence (ML7).

category_fit reads the cuisine model (P2-02, app/cuisine_model.py); the return score, visits,
and known price come from the place model (P2-10, app/place_model.py). Both run once per round
with as_of = the local date.
"""

from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta

from app.categories import OTHER, map_category
from app.cuisine_model import CuisinePrediction, predict
from app.place_model import PlaceScore, place_scores
from app.places import Candidate, distance_m, verified_cuisine
from app.refine import radius_level
from app.scoring_rules import (
    CLOSE_M,
    CRAVING_MATCH_FIT,
    CRAVING_OTHER_FACTOR,
    DONT_MIND_WEIGHTS,
    MEAL_SLOT_STARTS,
    OTHER_FIT,
    PRICE_FIT_BY_LEVELS_ABOVE,
    PRICE_FIT_UNKNOWN,
    SCORE_DIGITS,
    USUAL_MIN_SHARE,
    WEAK_MIN_MEALS,
    WEAK_TOP_PROB,
    WEIGHTS,
)

FAMILIAR, DISCOVERY = "familiar", "discovery"


# Inputs ----------------------------------------------------------------------


@dataclass(frozen=True)
class QuizPrior:
    """taste_profiles (FR1). Empty favorites = no quiz yet."""

    favorites: frozenset[str] = frozenset()
    hard_nos: frozenset[str] = frozenset()
    budget_level: int | None = None  # 1-4
    mostly_solo: bool | None = None


@dataclass(frozen=True)
class StoredPlace:
    """A resolved row of the places table. Unresolved places are never loaded as one."""

    id: str
    name: str
    lat: float
    lon: float
    geoapify_categories: tuple[str, ...]
    address: str | None


@dataclass(frozen=True)
class PastMeal:
    """A meal that counts: backfill, or live with went = true. Newest first in History.

    category_id is the food eaten (backfill CSV, or the live "What did you have?" answer). It
    never changes the place's category, which comes only from map_category (ML2). A live
    meal with no food answer yet still holds the pick-time place category, so the cuisine
    model skips it (food_answered = False).
    """

    place: StoredPlace | None  # None: unresolved backfill place (cuisine model only)
    eaten_on: date
    source: str  # "backfill" or "live"
    category_id: str | None  # the food eaten; see above
    price_level: int | None  # what was paid: price tap, else backfill amount as a level
    meal_slot: str | None = None  # breakfast, lunch, dinner, late
    is_weekend: bool | None = None  # from eaten_on; None = derive it
    dish: str | None = None  # loaded, not scored
    food_answered: bool = False  # live: the food answer was given (meals.ate_at)
    went: bool | None = None  # live: True for every loaded live meal; None for backfill
    companion_ids: frozenset[str] = frozenset()
    solo: bool | None = None
    stars: int | None = None  # live only, 1-5
    distance_m: int | None = None  # stored distance from a live session's origin


@dataclass(frozen=True)
class History:
    prior: QuizPrior = QuizPrior()
    meals: tuple[PastMeal, ...] = ()
    companions: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Context:
    """The session (ML1 context + answers). Answers are None until given."""

    lat: float
    lon: float
    local_date: date
    meal_slot: str
    is_weekend: bool
    search_radius_m: int  # radius Geoapify was searched with
    companion_ids: frozenset[str] = frozenset()  # used by P2-07, not by v1
    craving: str | None = None  # ML2 category id
    budget_level: int | None = None  # 1-4, overrides the quiz budget
    radius_m: int | None = None  # distance chip: 1500, 5000, 15000
    exclude_ids: frozenset[str] = frozenset()  # rejected earlier in this session (ML10)
    exclude_categories: frozenset[str] = frozenset()  # ruled out in the chat ("not burgers")
    required_craving: str | None = None  # explicit positive answer, never a prediction


def meal_context(local: datetime) -> tuple[str, date, bool]:
    """Local time -> (meal slot, local date, is weekend). Late after midnight is the day before."""
    slot = MEAL_SLOT_STARTS[-1][1]
    for start, name in MEAL_SLOT_STARTS:
        if local.hour >= start:
            slot = name
    day = local.date()
    if local.hour < MEAL_SLOT_STARTS[0][0]:
        day -= timedelta(days=1)
    return slot, day, day.isoweekday() >= 6


# Merge (#13 follow-up) -------------------------------------------------------


def merge_candidates(
    searched: list[Candidate], history: History, context: Context
) -> tuple[list[Candidate], frozenset[str]]:
    """Geoapify results + previously visited places within the search radius.

    Geoapify returns at most 100 places, nearest first, so known places farther out can be
    cut off. Stored places were returned by Geoapify on an earlier search (R2). Dedupe on id;
    the Geoapify row wins. Stored places are mapped again so the category stays current; a
    meal's food label never changes a place's category. Unresolved places are skipped.
    Returns the candidates, nearest first, and the ids that came only from history.
    """
    by_id = {c.id: c for c in searched}
    merged_ids: set[str] = set()
    for meal in history.meals:
        place = meal.place
        if place is None or place.id in by_id:
            continue
        d = distance_m(context.lat, context.lon, place.lat, place.lon)
        if d > context.search_radius_m:
            continue
        by_id[place.id] = Candidate(
            id=place.id,
            name=place.name,
            lat=place.lat,
            lon=place.lon,
            distance_m=d,
            category=map_category(place.geoapify_categories, place.name),
            geoapify_categories=list(place.geoapify_categories),
            address=place.address,
        )
        merged_ids.add(place.id)
    candidates = sorted(by_id.values(), key=lambda c: (c.distance_m, c.id))
    return candidates, frozenset(merged_ids)


# Fits ------------------------------------------------------------------------


def category_fit(category: str, prediction: CuisinePrediction) -> tuple[float, str]:
    """p(category) / max p, so the top category fits 1.0. Returns (fit, source = level)."""
    if category == OTHER:
        return OTHER_FIT, "other"
    top = max(prediction.probs.values(), default=0.0)
    if top <= 0:
        return 0.0, prediction.level
    return prediction.probs.get(category, 0.0) / top, prediction.level


def usual_categories(prediction: CuisinePrediction, prior: QuizPrior) -> frozenset[str]:
    """At least USUAL_MIN_SHARE of the user's recency-weighted meals (raw, unsmoothed).
    No counted meals yet: quiz favorites minus hard no's (REQUIREMENTS, Usual categories)."""
    if not prediction.user_meals:
        return prior.favorites - prior.hard_nos
    return frozenset(c for c, s in prediction.user_shares.items() if s >= USUAL_MIN_SHARE)


def weak(top_prob: float, meals: int) -> bool:
    """ML6: top probability under WEAK_TOP_PROB, or fewer than WEAK_MIN_MEALS raw meals."""
    return top_prob < WEAK_TOP_PROB or meals < WEAK_MIN_MEALS


def is_weak(prediction: CuisinePrediction) -> bool:
    """ML6 for the cuisine model: weak() on the top probability and the raw meals behind the
    reported level (FR-R3: meals in that context). Used by the confidence gate (P2-05)."""
    return weak(max(prediction.probs.values(), default=0.0), prediction.meals)


def price_fit(known_level: int | None, budget_level: int | None) -> float:
    """Full at or below budget, half one level above, none two or more; unknown = half."""
    if known_level is None or budget_level is None:
        return PRICE_FIT_UNKNOWN
    above = max(0, known_level - budget_level)
    return PRICE_FIT_BY_LEVELS_ABOVE[min(above, len(PRICE_FIT_BY_LEVELS_ABOVE) - 1)]


def distance_fit(distance: int, radius_m: int) -> float:
    return max(0.0, 1.0 - distance / radius_m)


# Ranking ---------------------------------------------------------------------


@dataclass(frozen=True)
class Evidence:
    """Plain data behind a score. Stage B's Muse prompt words this; it never changes it."""

    category: str
    category_fit: float
    category_source: str  # cuisine model level ("quiz", "user", "slot", "slot_weekend"), "other"
    category_meals: int  # raw counted meals of this food category (not visits to the place)
    craving: str | None
    return_score: float  # place model, in [-1, 1]; 0 = never visited
    price_fit: float
    known_price_level: int | None
    budget_level: int | None
    distance_fit: float
    distance_m: int
    radius_m: int
    visits: int
    last_visit_days: int | None
    stars_mean: float | None  # the user's own recency-weighted mean stars; None = no ratings
    from_history: bool  # merged from Supabase, not in this Geoapify response
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class Scored:
    place: Candidate
    score: float
    evidence: Evidence


@dataclass(frozen=True)
class Pick:
    rank: int  # 1-3
    slot: str  # "familiar" or "discovery"
    scored: Scored


@dataclass(frozen=True)
class Ranking:
    ranked: tuple[Scored, ...]  # every allowed candidate, best first
    top3: tuple[Pick, ...]
    usual: frozenset[str]  # categories the familiar slots draw from this round
    cold_start: bool  # no usual categories (no favorites, no meals) and no craving


def score_candidate(
    place: Candidate,
    history: History,
    context: Context,
    places: dict[str, PlaceScore],
    merged_ids: frozenset[str],
    prediction: CuisinePrediction,
    usual: frozenset[str],
) -> Scored:
    """usual is the model's usual categories (not the craving), for the usual_category signal."""
    reasons: list[str] = []

    cat_fit, cat_source = category_fit(place.category, prediction)
    if place.category in history.prior.favorites:
        reasons.append("favorite_category")
    if prediction.user_meals and place.category in usual:
        reasons.append("usual_category")
    if context.craving:
        if place.category == context.craving:
            cat_fit = CRAVING_MATCH_FIT
            reasons.append("craving_match")
        else:
            cat_fit *= CRAVING_OTHER_FACTOR
    if place.category == OTHER:
        reasons.append("category_unknown")

    visited = places.get(place.id)
    ret = visited.return_score if visited else 0.0
    if visited:
        reasons.append("visited_before")

    known = visited.known_price_level if visited else None
    budget = context.budget_level or history.prior.budget_level
    p_fit = price_fit(known, budget)
    if known is None or budget is None:
        reasons.append("price_unknown")
    elif p_fit == PRICE_FIT_BY_LEVELS_ABOVE[0]:
        reasons.append("price_fits")
    else:
        reasons.append("price_above_budget")

    radius = context.radius_m or context.search_radius_m
    d_fit = distance_fit(place.distance_m, radius)
    if place.distance_m <= CLOSE_M:
        reasons.append("close")
    elif place.distance_m > radius:
        reasons.append("beyond_radius")

    # "I don't mind" the distance (P1-19): distance weighs less, category more.
    w = DONT_MIND_WEIGHTS if radius_level(context.radius_m) == "dont_mind" else WEIGHTS
    score = round(
        w["category"] * cat_fit
        + w["return"] * ret
        + w["price"] * p_fit
        + w["distance"] * d_fit,
        SCORE_DIGITS,
    )
    evidence = Evidence(
        category=place.category,
        category_fit=cat_fit,
        category_source=cat_source,
        category_meals=prediction.user_counts.get(place.category, 0),
        craving=context.craving,
        return_score=ret,
        price_fit=p_fit,
        known_price_level=known,
        budget_level=budget,
        distance_fit=round(d_fit, SCORE_DIGITS),
        distance_m=place.distance_m,
        radius_m=radius,
        visits=visited.visits if visited else 0,
        last_visit_days=visited.last_visit_days if visited else None,
        stars_mean=visited.stars_mean if visited else None,
        from_history=place.id in merged_ids,
        reasons=tuple(reasons),
    )
    return Scored(place, score, evidence)


def rank_key(s: Scored) -> tuple[float, int, str]:
    # Higher score, then nearer, then id: the same input always gives the same order.
    return (-s.score, s.place.distance_m, s.place.id)


@dataclass(frozen=True)
class Models:
    """The model outputs a round ranks with. They depend on history, the local date, and the
    meal slot and weekday/weekend, never on the answers, so one copy serves every re-rank of
    the round (P2-05 information gain)."""

    places: dict[str, PlaceScore]
    prediction: CuisinePrediction
    usual: frozenset[str]  # the model's usual categories (not the craving)


def models_for(history: History, context: Context) -> Models:
    prediction = predict(history, context, as_of=context.local_date)
    return Models(
        places=place_scores(history, as_of=context.local_date),
        prediction=prediction,
        usual=usual_categories(prediction, history.prior),
    )


def rank(
    candidates: list[Candidate],
    context: Context,
    history: History,
    merged_ids: frozenset[str] = frozenset(),
    models: Models | None = None,
) -> Ranking:
    """Hard no's, excluded categories, and rejected places are dropped, the rest scored,
    top 3 = 2 familiar + 1 discovery (ML5). A craving answer makes the craved category the
    familiar one. models: precomputed models_for(history, context), else computed here."""
    m = models or models_for(history, context)
    places, prediction, model_usual = m.places, m.prediction, m.usual
    allowed = [
        c
        for c in candidates
        if c.category not in history.prior.hard_nos
        and c.category not in context.exclude_categories
        and c.id not in context.exclude_ids
        and verified_cuisine(c.category, c.geoapify_categories, context.required_craving)
    ]
    ranked = tuple(
        sorted(
            (
                score_candidate(c, history, context, places, merged_ids, prediction, model_usual)
                for c in allowed
            ),
            key=rank_key,
        )
    )
    usual = frozenset({context.craving}) if context.craving else model_usual
    cold_start = not usual
    return Ranking(ranked, pick_top3(ranked, usual, cold_start), usual, cold_start)


def pick_top3(
    ranked: tuple[Scored, ...], usual: frozenset[str], cold_start: bool
) -> tuple[Pick, ...]:
    """Ranks 1-2 familiar, rank 3 discovery. Empty slots fill from the best remaining.

    Familiar = best in the usual categories. Discovery = best outside them, preferring a
    known category over Other. Cold start (no usual categories): the two best overall, then
    the best in a category the first two don't have.
    """
    chosen: list[Scored] = []

    def best(match) -> Scored | None:
        ids = {c.place.id for c in chosen}
        return next((s for s in ranked if s.place.id not in ids and match(s)), None)

    if cold_start:
        chosen.extend(ranked[:2])
    else:
        chosen.extend([s for s in ranked if s.place.category in usual][:2])
    while len(chosen) < 2 and (fill := best(lambda s: True)):
        chosen.append(fill)

    taken = {s.place.category for s in chosen}
    outside = taken if cold_start else usual
    discovery = (
        best(lambda s: s.place.category not in outside and s.place.category != OTHER)
        or best(lambda s: s.place.category not in outside)
        or best(lambda s: True)
    )
    if discovery:
        chosen.append(discovery)

    picks = []
    for i, s in enumerate(chosen):
        slot = DISCOVERY if i == 2 else FAMILIAR
        extra = (("discovery",) if slot == DISCOVERY else ()) + (
            ("cold_start",) if cold_start else ()
        )
        if extra:
            s = replace(s, evidence=replace(s.evidence, reasons=s.evidence.reasons + extra))
        picks.append(Pick(rank=i + 1, slot=slot, scored=s))
    return tuple(picks)
