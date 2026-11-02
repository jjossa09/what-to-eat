import json
from datetime import date, timedelta

import pytest

from app.cuisine_model import PREDICTABLE, predict
from app.scoring import History, PastMeal, QuizPrior, StoredPlace
from app.scoring_rules import HALF_LIFE_DAYS, SMOOTHING_K
from scripts import evaluate as ev

D0 = date(2026, 10, 5)  # a Monday
THAI_TAGS = ("catering.restaurant.thai",)
PIZZA_TAGS = ("catering.restaurant.pizza",)


def place(pid: str, name: str | None = None, tags=THAI_TAGS) -> StoredPlace:
    return StoredPlace(id=pid, name=name or pid, lat=0.0, lon=0.0, geoapify_categories=tags,
                       address=None)


def meal(day: int, slot: str, category: str, pid: str | None = None, tags=THAI_TAGS,
         name: str | None = None) -> PastMeal:
    return PastMeal(place=place(pid, name, tags) if pid else None,
                    eaten_on=D0 + timedelta(days=day), source="backfill", category_id=category,
                    price_level=None, meal_slot=slot)


def history(*meals: PastMeal, prior: QuizPrior = QuizPrior()) -> History:
    return History(prior=prior, meals=tuple(reversed(meals)))  # newest first, like the API


# Replay order and leakage.


def test_replay_order_is_date_then_slot():
    meals = [meal(1, "dinner", "thai"), meal(0, "late", "thai"), meal(1, "breakfast", "thai"),
             meal(0, "lunch", "thai")]
    order = [(m.eaten_on.day, m.meal_slot) for m in ev.replay_order(meals)]
    assert order == [(5, "lunch"), (5, "late"), (6, "breakfast"), (6, "dinner")]


def test_cuisine_replay_never_sees_same_day_or_later_meals():
    # Pizza appears only on day 1. If as_of were one day late, day 1 lunch would see both pizza
    # meals and predict pizza (a hit). Correct replay sees only thai, so top-1 never hits.
    h = history(meal(0, "lunch", "thai"), meal(1, "lunch", "pizza"), meal(1, "dinner", "pizza"))
    result = ev.evaluate_cuisine(h, QuizPrior())
    assert result.all.n == 3
    assert result.all.model[1] == 0
    assert result.all.frequent[1] == 0


def test_place_pool_excludes_same_day_places():
    h = history(meal(0, "lunch", "thai", "node/a"), meal(1, "lunch", "thai", "node/b"),
                meal(1, "dinner", "thai", "node/b"))
    result = ev.evaluate_places(h, QuizPrior())
    assert result.new_place == 3  # day 1 dinner's earlier B visit is the same day
    assert result.all.model[3] == 0 and result.repeat.n == 0


def test_predict_matches_an_independent_ml3_reimplementation():
    # Written from the spec, not from cuisine_model: uniform L0, then user, slot, and
    # slot + weekday/weekend, each p = (weighted count + K * parent p) / (weighted n + K).
    meals = [meal(0, "lunch", "thai"), meal(2, "dinner", "pizza"), meal(5, "lunch", "pizza"),
             meal(6, "lunch", "mexican"), meal(9, "dinner", "thai"), meal(12, "lunch", "thai"),
             meal(13, "late", "dessert")]
    h = history(*meals)
    for target in ev.cuisine_targets(h.meals):
        as_of = target.eaten_on
        past = [m for m in meals if m.eaten_on < as_of]
        wk = target.eaten_on.isoweekday() >= 6
        p = dict.fromkeys(PREDICTABLE, 1 / len(PREDICTABLE))
        for keep in (lambda m: True, lambda m: m.meal_slot == target.meal_slot,
                     lambda m: m.meal_slot == target.meal_slot
                     and (m.eaten_on.isoweekday() >= 6) == wk):
            sub = [(m, 0.5 ** ((as_of - m.eaten_on).days / HALF_LIFE_DAYS)) for m in past
                   if keep(m)]
            n = sum(w for _, w in sub)
            p = {c: (sum(w for m, w in sub if m.category_id == c) + SMOOTHING_K * p[c])
                 / (n + SMOOTHING_K) for c in PREDICTABLE}
        real = predict(h, ev.context_of(target), as_of).probs
        assert real == pytest.approx(p, abs=1e-12)


# Baselines on a hand-computed history.


def five_meals(prior=QuizPrior()) -> History:
    return history(
        meal(0, "lunch", "thai", "node/a"),
        meal(1, "lunch", "pizza", "node/b", PIZZA_TAGS),
        meal(2, "lunch", "thai", "node/a"),
        meal(3, "dinner", "pizza", "node/b", PIZZA_TAGS),
        meal(4, "dinner", "pizza", "node/b", PIZZA_TAGS),
        prior=prior,
    )


def test_cuisine_baselines_by_hand():
    # Most frequent so far, ties alphabetical:
    # day 0: none -> american_diner, bbq, breakfast_brunch; thai misses both.
    # day 1: thai 1 -> thai first; pizza misses both.
    # day 2: thai 1, pizza 1 -> pizza first; thai misses top-1, hits top-3.
    # day 3: thai 2, pizza 1 -> thai; pizza hits top-3 only.
    # day 4: thai 2, pizza 2 -> pizza first; hits both.
    result = ev.evaluate_cuisine(five_meals(), QuizPrior())
    assert result.all.n == 5
    assert result.all.frequent[1] == 1
    assert result.all.frequent[3] == 3
    assert result.allowed == len(PREDICTABLE) == 24  # the 24 ML2 categories; Other never
    assert result.all.random[1] / 5 == pytest.approx(1 / 24)
    assert result.all.random[3] / 5 == pytest.approx(3 / 24)


def test_place_baselines_by_hand():
    # day 0 A: empty pool, new. day 1 B: pool {A}, new.
    # day 2 A: A 1, B 1 -> tie by id, A first: hit. Random 1/2, top-3 1.
    # day 3 B: A 2, B 1 -> A first: top-3 hit only. day 4 B: A 2, B 2 -> A first: top-3 only.
    result = ev.evaluate_places(five_meals(), QuizPrior())
    assert result.all.n == 5 and result.new_place == 2
    assert result.all.frequent[1] == 1 and result.all.frequent[3] == 3
    assert result.all.random[1] / 5 == pytest.approx(1.5 / 5)
    assert result.all.random[3] / 5 == pytest.approx(3 / 5)
    assert result.repeat.n == 3
    assert result.repeat.frequent[1] == 1 and result.repeat.frequent[3] == 3
    assert result.repeat.random[1] / 3 == pytest.approx(0.5)
    assert result.repeat.random[3] / 3 == pytest.approx(1.0)


def test_disagreements_are_counted_both_ways():
    result = ev.evaluate_cuisine(five_meals(), QuizPrior())
    assert len(result.disagree_n_eff) == result.model_only + result.frequent_only
    assert result.frequent_only - result.model_only == (
        result.all.frequent[3] - result.all.model[3])


def test_slot_rows_need_three_meals():
    result = ev.evaluate_cuisine(five_meals(), QuizPrior())
    assert [s for s, _ in result.slot_rows()] == ["lunch"]  # dinner has n = 2


def test_hard_no_meals_are_misses_under_the_quiz_prior():
    prior = QuizPrior(favorites=frozenset({"pizza"}), hard_nos=frozenset({"thai"}))
    cold = ev.evaluate_cuisine(five_meals(), QuizPrior())
    quiz = ev.evaluate_cuisine(five_meals(prior), prior)
    assert quiz.all.n == cold.all.n == 5  # same meal set
    assert quiz.hard_no_misses == 2 and quiz.allowed == 23
    # Random: the 3 pizza meals at 1/23 each, the 2 thai meals at 0.
    assert quiz.all.random[1] == pytest.approx(3 / 23)
    # Thai places are hard no's too: never in the pool, so repeat visits there miss.
    places = ev.evaluate_places(five_meals(prior), prior)
    assert places.hard_no_misses == 1  # day 2 at A
    assert places.all.model[3] == 2  # days 3 and 4 at B


def test_model_ranks_places_by_category_and_return():
    # B (pizza place) beats A (thai place) on both terms by day 3: more pizza eaten, more visits.
    # Day 1: pool {B}, hit. Day 3: pool {A, B}, B first, hit. Days 0 and 2 are new places.
    h = history(meal(0, "lunch", "pizza", "node/b", tags=PIZZA_TAGS),
                meal(1, "lunch", "pizza", "node/b", tags=PIZZA_TAGS),
                meal(2, "lunch", "thai", "node/a"),
                meal(3, "lunch", "pizza", "node/b", tags=PIZZA_TAGS))
    result = ev.evaluate_places(h, QuizPrior())
    assert result.all.model[1] == 2  # days 1 and 3 at B, ranked first by both terms


# New places.


def test_every_new_place_is_a_miss():
    h = history(*(meal(d, "lunch", "thai", f"node/{d}") for d in range(4)))
    result = ev.evaluate_places(h, QuizPrior())
    assert result.all.n == result.new_place == 4
    assert result.all.model[3] == result.all.frequent[3] == 0
    assert result.all.random[3] == 0
    assert result.repeat.n == 0


def test_unresolved_and_slotless_meals_are_left_out_of_place():
    unresolved = meal(1, "lunch", "thai")
    slotless = PastMeal(place=place("node/a"), eaten_on=D0, source="backfill",
                        category_id="thai", price_level=None, meal_slot=None)
    h = history(slotless, unresolved, meal(2, "lunch", "thai", "node/a"))
    assert ev.evaluate_places(h, QuizPrior()).all.n == 1
    assert ev.evaluate_cuisine(h, QuizPrior()).all.n == 2


# Wilson.


def test_wilson_known_values():
    lo, hi = ev.wilson(5, 10)
    assert lo == pytest.approx(0.2366, abs=1e-4) and hi == pytest.approx(0.7634, abs=1e-4)
    lo, hi = ev.wilson(0, 10)
    assert lo == 0.0 and hi == pytest.approx(0.2775, abs=1e-4)
    lo, hi = ev.wilson(10, 10)
    assert lo == pytest.approx(0.7225, abs=1e-4) and hi == pytest.approx(1.0)
    assert ev.wilson(0, 0) is None


# Report.


def test_random_has_no_interval_and_observed_rates_do():
    report = ev.render_report(five_meals(), ev.build_runs(five_meals(), with_quiz=False),
                              "test", date(2026, 11, 1))
    random_row = next(line for line in report.splitlines() if line.startswith("| Random"))
    assert "expected (analytic)" in random_row and "CI" not in random_row
    model_row = next(line for line in report.splitlines() if line.startswith("| Model"))
    assert "CI" in model_row


def test_quiz_run_is_labeled():
    prior = QuizPrior(favorites=frozenset({"thai"}))
    h = five_meals(prior)
    report = ev.render_report(h, ev.build_runs(h, with_quiz=True), "test", date(2026, 11, 1))
    assert "Run A: strict cold start" in report
    assert "after the backfill period" in report
    assert "No parameter was changed or searched" in report
    assert "## Diagnosis" in report and "Run A: strict cold start, cuisine top-3" in report


def test_csv_mode_end_to_end_and_report_has_no_private_values(tmp_path):
    csv_path = tmp_path / "backfill.csv"
    csv_path.write_text(
        "date,meal_slot,place,category,price,companions\n"
        "2026-10-05,lunch,Zyxqu Taqueria,mexican,12.34,Quinnelope\n"
        "2026-10-06,lunch,Zyxqu Taqueria,mexican,13.57,solo\n"
        "2026-10-07,dinner,Vorbleck Noodle Bar,thai,21.09,Quinnelope;Marisandro\n"
        "2026-10-08,lunch,Zyxqu Taqueria,mexican,,\n",
        encoding="utf-8",
    )
    res_path = tmp_path / "resolutions.json"
    res_path.write_text(json.dumps({
        "zyxqu taqueria": {"id": "node/777001", "name": "Zyxqu Taqueria", "lat": 1.0,
                           "lon": 2.0, "address": "1 Plumtree Lane",
                           "geoapify_categories": ["catering.restaurant.mexican"]},
        "vorbleck noodle bar": {"unresolved": True, "name": "Vorbleck Noodle Bar"},
    }), encoding="utf-8")
    out = tmp_path / "EVALUATION.md"

    assert ev.main(["--csv", str(csv_path), "--resolutions", str(res_path),
                    "--out", str(out)]) == 0
    report = out.read_text(encoding="utf-8")
    assert "n = 4 meals" in report  # cuisine
    assert "n = 3 meals at resolved places" in report
    assert "only the strict cold start run" in report
    for private in ("Zyxqu", "Taqueria", "Vorbleck", "Noodle", "Quinnelope", "Marisandro",
                    "Plumtree", "777001", "12.34", "13.57", "21.09", "2026-10-0"):
        assert private not in report


def test_csv_mode_needs_every_place_resolved(tmp_path, capsys):
    csv_path = tmp_path / "backfill.csv"
    csv_path.write_text("date,meal_slot,place,category,price,companions\n"
                        "2026-10-05,lunch,Somewhere,thai,,\n", encoding="utf-8")
    res_path = tmp_path / "resolutions.json"
    res_path.write_text("{}", encoding="utf-8")
    assert ev.main(["--csv", str(csv_path), "--resolutions", str(res_path),
                    "--out", str(tmp_path / "out.md")]) == 2
    assert "not in" in capsys.readouterr().err
    assert not (tmp_path / "out.md").exists()
