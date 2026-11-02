"""Descriptive chart data for Insights. Pure aggregation, without predictions."""

from collections import Counter
from collections.abc import Iterable
from datetime import date
from statistics import median

from app.categories import CATEGORY_IDS
from app.companion_metrics import Meal

SLOTS = ("breakfast", "lunch", "dinner", "late")
LEVELS = (1, 2, 3, 4)


def aggregate(meals: Iterable[Meal], as_of: date) -> dict:
    visits = [m for m in meals if m.eaten_on <= as_of
              and (m.source == "backfill" or m.went is True)]
    food = [m for m in visits if m.category_id is not None
            and (m.source == "backfill" or m.food_answered)]
    counts = Counter(m.category_id for m in food)
    ranked = sorted(counts, key=lambda cat: (-counts[cat], CATEGORY_IDS.index(cat)))
    cutoff = counts[ranked[4]] if len(ranked) >= 5 else 0
    top = [{"category_id": cat, "meal_count": counts[cat]}
           for cat in ranked if counts[cat] >= cutoff]
    prices, foods, distances = [], [], []
    for slot in SLOTS:
        slot_meals = [m for m in visits if m.meal_slot == slot]
        paid = Counter(m.paid_level for m in slot_meals if m.paid_level is not None)
        budgets = Counter(m.budget_level for m in slot_meals if m.budget_level is not None)
        slot_food = Counter(m.category_id for m in food if m.meal_slot == slot)
        maximum = max(slot_food.values(), default=0)
        measured = [m.distance_m for m in slot_meals
                    if m.source == "live" and m.distance_m is not None]
        prices.append({"meal_slot": slot, "levels": [
            {"level": level, "paid_count": paid[level], "budget_count": budgets[level]}
            for level in LEVELS],
            "missing_meal_count": sum(m.paid_level is None and m.budget_level is None
                                      for m in slot_meals)})
        foods.append({"meal_slot": slot, "category_meal_count": sum(slot_food.values()),
                      "leaders": [{"category_id": cat, "meal_count": slot_food[cat]}
                                  for cat in CATEGORY_IDS
                                  if slot_food[cat] == maximum and maximum]})
        distances.append({"meal_slot": slot, "measured_meal_count": len(measured),
                          "median_m": median(measured) if measured else None})
    return {
        "summary": {"meal_count": len(visits), "category_meal_count": len(food)},
        "price_by_slot": prices,
        "food_by_slot": foods,
        "distance_by_slot": distances,
        "top_categories": top,
        # Coverage categories can overlap: a visit can lack both a slot and a price.
        "coverage": {
            "unknown_slot_meals": sum(m.meal_slot is None for m in visits),
            "missing_price_meals": sum(m.paid_level is None and m.budget_level is None
                                       for m in visits),
            "backfill_distance_meals": sum(m.source == "backfill" for m in visits),
            "missing_distance_meals": sum(m.source == "live" and m.distance_m is None
                                          for m in visits),
        },
    }
