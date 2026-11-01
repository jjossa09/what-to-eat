"""Deterministic scoring v1 (P1-12, FR7, ML5): candidates + context + history -> top 3.

Pure functions, no I/O, no clock: the caller passes the local date. Weights and thresholds
are in app/scoring_rules.py. Muse never touches this; it only words the evidence (ML7).

category_fit and return_score are the model slots: P2-02 (cuisine model) and P2-10 (place
model) replace their bodies without changing the rest.
"""

from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta

from app.categories import OTHER, map_category
from app.places import Candidate, distance_m
from app.refine import radius_level
from app.scoring_rules import (
    CLOSE_M,
    CRAVING_MATCH_FIT,
    CRAVING_OTHER_FACTOR,
    DONT_MIND_WEIGHTS,
    FAVORITE_FIT,
    MEAL_SLOT_STARTS,
    NON_FAVORITE_FIT,
    OTHER_FIT,
    PRICE_FIT_BY_LEVELS_ABOVE,
    PRICE_FIT_UNKNOWN,
    SCORE_DIGITS,
    UNIFORM_FIT,
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


@dataclass(frozen=True)
class StoredPlace:
    """A resolved row of the places table (unresolved places never become candidates)."""

    id: str
    name: str
    lat: float
    lon: float
    geoapify_categories: tuple[str, ...]
    address: str | None


@dataclass(frozen=True)
class PastMeal:
    """A meal that counts: backfill, or live with went = true. Newest first in History."""

    place: StoredPlace
    eaten_on: date
    source: str  # "backfill" or "live"
    category_id: str | None  # backfill: the user's label, which overrides the ML2 mapping
    price_level: int | None  # what was paid: price tap, else backfill amount as a level


@dataclass(frozen=True)
class History:
    prior: QuizPrior = QuizPrior()
    meals: tuple[PastMeal, ...] = ()


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
    the Geoapify row wins. Stored places are mapped again so the category stays current, and
    the user's backfill label overrides the mapping for any place. Returns the candidates,
    nearest first, and the ids that came only from history.
    """
    labels = backfill_labels(history)
    by_id = {c.id: c for c in searched}
    merged_ids: set[str] = set()
    for meal in history.meals:
        place = meal.place
        if place.id in by_id:
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
    candidates = [
        replace(c, category=labels[c.id]) if c.id in labels else c for c in by_id.values()
    ]
    candidates.sort(key=lambda c: (c.distance_m, c.id))
    return candidates, frozenset(merged_ids)


def backfill_labels(history: History) -> dict[str, str]:
    """Place id -> the user's most recent backfill category label for it."""
    labels: dict[str, str] = {}
    for meal in history.meals:  # newest first, so the first label seen wins
        if meal.source == "backfill" and meal.category_id:
            labels.setdefault(meal.place.id, meal.category_id)
    return labels


# Fits ------------------------------------------------------------------------


@dataclass(frozen=True)
class PlaceStats:
    visits: int
    last_visit_days: int | None
    price_level: int | None  # most recent known price at this place


def place_stats(history: History, today: date) -> dict[str, PlaceStats]:
    stats: dict[str, PlaceStats] = {}
    for meal in history.meals:  # newest first
        pid = meal.place.id
        prev = stats.get(pid)
        if prev is None:
            stats[pid] = PlaceStats(1, (today - meal.eaten_on).days, meal.price_level)
        else:
            price = prev.price_level if prev.price_level is not None else meal.price_level
            stats[pid] = replace(prev, visits=prev.visits + 1, price_level=price)
    return stats


def category_fit(category: str, history: History, context: Context) -> tuple[float, str]:
    """v1: quiz prior, else uniform (ML5 Phase 1). Returns (fit, source). P2-02 replaces this."""
    if category == OTHER:
        return OTHER_FIT, "other"
    favorites = history.prior.favorites
    if not favorites:
        return UNIFORM_FIT, "uniform"
    return (FAVORITE_FIT if category in favorites else NON_FAVORITE_FIT), "quiz_prior"


def usual_categories(history: History, context: Context) -> frozenset[str]:
    """v1: quiz favorites (until data exists, REQUIREMENTS). P2-02 adds the 15% rule."""
    return history.prior.favorites - history.prior.hard_nos


def return_score(stats: PlaceStats | None, context: Context) -> float:
    """v1: 0 for every place. P2-10 replaces this with visits, recency, and stars (ML4)."""
    return 0.0


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
    category_source: str  # "quiz_prior", "uniform", "other"
    craving: str | None
    return_score: float
    price_fit: float
    known_price_level: int | None
    budget_level: int | None
    distance_fit: float
    distance_m: int
    radius_m: int
    visits: int
    last_visit_days: int | None
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
    cold_start: bool  # no quiz favorites and no craving: distance decides


def score_candidate(
    place: Candidate,
    history: History,
    context: Context,
    stats: dict[str, PlaceStats],
    merged_ids: frozenset[str],
) -> Scored:
    reasons: list[str] = []

    cat_fit, cat_source = category_fit(place.category, history, context)
    if cat_source == "quiz_prior" and place.category in history.prior.favorites:
        reasons.append("favorite_category")
    if context.craving:
        if place.category == context.craving:
            cat_fit = CRAVING_MATCH_FIT
            reasons.append("craving_match")
        else:
            cat_fit *= CRAVING_OTHER_FACTOR
    if place.category == OTHER:
        reasons.append("category_unknown")

    place_stat = stats.get(place.id)
    ret = return_score(place_stat, context)
    if place_stat:
        reasons.append("visited_before")

    known = place_stat.price_level if place_stat else None
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
        craving=context.craving,
        return_score=ret,
        price_fit=p_fit,
        known_price_level=known,
        budget_level=budget,
        distance_fit=round(d_fit, SCORE_DIGITS),
        distance_m=place.distance_m,
        radius_m=radius,
        visits=place_stat.visits if place_stat else 0,
        last_visit_days=place_stat.last_visit_days if place_stat else None,
        from_history=place.id in merged_ids,
        reasons=tuple(reasons),
    )
    return Scored(place, score, evidence)


def rank_key(s: Scored) -> tuple[float, int, str]:
    # Higher score, then nearer, then id: the same input always gives the same order.
    return (-s.score, s.place.distance_m, s.place.id)


def rank(
    candidates: list[Candidate],
    context: Context,
    history: History,
    merged_ids: frozenset[str] = frozenset(),
) -> Ranking:
    """Hard no's, excluded categories, and rejected places are dropped, the rest scored,
    top 3 = 2 familiar + 1 discovery (ML5). A craving answer makes the craved category the
    familiar one."""
    stats = place_stats(history, context.local_date)
    allowed = [
        c
        for c in candidates
        if c.category not in history.prior.hard_nos
        and c.category not in context.exclude_categories
        and c.id not in context.exclude_ids
    ]
    ranked = tuple(
        sorted(
            (score_candidate(c, history, context, stats, merged_ids) for c in allowed),
            key=rank_key,
        )
    )
    if context.craving:
        usual = frozenset({context.craving})
    else:
        usual = usual_categories(history, context)
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
