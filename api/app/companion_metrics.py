"""Descriptive companion metrics (P2-04). Pure counts, never predictions."""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from app.categories import CATEGORY_IDS


@dataclass(frozen=True)
class Meal:
    id: str
    source: str
    eaten_on: date
    day_of_week: int
    category_id: str | None
    food_answered: bool
    went: bool | None
    solo: bool | None
    companion_ids: frozenset[str]
    meal_slot: str | None = None
    paid_level: int | None = None
    budget_level: int | None = None
    distance_m: int | None = None


def aggregate(companion_ids: Iterable[str], meals: Iterable[Meal], as_of: date) -> dict:
    """Count whole participation through as_of; the caller supplies validated records."""
    saved = set(companion_ids)
    days = {cid: Counter() for cid in saved}
    categories = {cid: Counter() for cid in saved}
    sources = {cid: Counter() for cid in saved}
    unlinked = contradictory = with_company = 0
    for meal in meals:
        if meal.eaten_on > as_of or (meal.source == "live" and meal.went is not True):
            continue
        if meal.solo is True and meal.companion_ids:
            contradictory += 1
            continue
        linked = meal.companion_ids & saved
        if not linked:
            unlinked += 1
            continue
        with_company += 1
        for cid in linked:
            days[cid][meal.day_of_week] += 1
            sources[cid][meal.source] += 1
            if meal.category_id is not None and (meal.source == "backfill" or meal.food_answered):
                categories[cid][meal.category_id] += 1

    companions = []
    for cid in sorted(saved):
        n = sum(sources[cid].values())
        food_n = sum(categories[cid].values())
        enough = n >= 5
        day_max = max(days[cid].values(), default=0)
        category_max = max(categories[cid].values(), default=0)
        companions.append({
            "companion_id": cid,
            "meal_count": n,
            "category_meal_count": food_n,
            "source_counts": {"live": sources[cid]["live"], "backfill": sources[cid]["backfill"]},
            "weekdays": [{"iso_day": day, "meal_count": days[cid][day]} for day in range(1, 8)],
            "categories": [{"category_id": cat, "meal_count": categories[cid][cat]}
                           for cat in CATEGORY_IDS if categories[cid][cat]],
            "leading_day_ids": [day for day in range(1, 8) if days[cid][day] == day_max]
            if enough else None,
            "leading_category_ids": [cat for cat in CATEGORY_IDS
                                     if categories[cid][cat] == category_max]
            if enough and food_n else None,
            "pattern_status": "available" if enough else "insufficient_data",
        })
    return {"companions": companions, "with_company_meal_count": with_company, "coverage": {
        "unlinked_meals": unlinked, "contradictory_company_meals": contradictory,
    }}
