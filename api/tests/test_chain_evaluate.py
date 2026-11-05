"""Secondary #73 replay denominators; primary exact-place metric remains intact."""

from datetime import date, timedelta

import pytest

from app.scoring import History, PastMeal, QuizPrior, StoredPlace
from scripts import evaluate as ev

D0 = date(2026, 10, 1)


def meal(day, pid, *, brand="Synthetic Chain", qid="Q100", name="Synthetic venue", slot="dinner"):
    place = StoredPlace(f"node/{pid}", name, 0., 0., ("catering.restaurant.chinese",), None,
                        brand, qid)
    return PastMeal(place, D0 + timedelta(days=day), "backfill", "chinese", None, meal_slot=slot)


def test_exact_place_remains_a_miss_for_a_new_branch_while_known_chain_can_hit():
    h = History(meals=(meal(0, 1), meal(1, 2), meal(2, 2)))
    exact = ev.evaluate_places(h, QuizPrior())
    assert exact.all.n == 3 and exact.all.model[1] == 1 and exact.all.model[3] == 1
    assert exact.new_place == 2 and exact.repeat.n == 1
    chain = ev.evaluate_chains(h, QuizPrior())
    assert chain.all.n == 3 and chain.all.model[1] == 2 and chain.all.model[3] == 2
    assert chain.new_chain == 1 and chain.repeat.n == 2
    assert chain.all.frequent[1] == 2 and chain.all.random[1] == 2
    assert ev.evaluate_places(h, QuizPrior()) == exact


def test_chain_denominator_excludes_unknown_identity_and_unknown_slot_but_reports_coverage():
    h = History(meals=(meal(0, 1), meal(1, 2), meal(2, 3, brand=None, qid=None),
                       meal(3, 4, slot=None)))
    chain = ev.evaluate_chains(h, QuizPrior())
    assert ev.evaluate_places(h, QuizPrior()).all.n == 3
    assert chain.all.n == 2 and chain.no_identity == 1 and chain.chain_meals == 3
    assert chain.identity_sources == {"wikidata": 2}


def test_replay_uses_only_earlier_days_for_candidates_scores_and_identity_aliases():
    first = meal(0, 1, brand="Synthetic Chain", qid=None)
    second = meal(1, 2, brand="Synthetic Chain", qid=None)
    baseline = ev.evaluate_chains(History(meals=(first, second)), QuizPrior())
    future = meal(3, 3, brand="Synthetic Chain", qid="Q200", slot=None)
    changed = ev.evaluate_chains(History(meals=(first, second, future)), QuizPrior())
    assert baseline.all == changed.all and baseline.repeat == changed.repeat
    same_day = ev.evaluate_chains(History(meals=(meal(0, 1), meal(0, 2))), QuizPrior())
    assert same_day.all.model[3] == 0 and same_day.new_chain == 2


def test_chain_baselines_use_unique_allowed_chains_without_branch_double_counting():
    h = History(meals=(meal(0, 1), meal(0, 2), meal(0, 3, brand="Other", qid="Q200"),
                       meal(1, 4, brand="Other", qid="Q200")))
    result = ev.evaluate_chains(h, QuizPrior())
    assert result.all.n == 4 and result.all.model[3] == 1
    assert result.all.random[1] == pytest.approx(.5)
    assert result.all.random[3] == 1
    blocked = ev.evaluate_chains(h, QuizPrior(hard_nos=frozenset({"chinese"})))
    assert blocked.all.n == 4 and blocked.all.model[3] == 0
    assert blocked.all.frequent[3] == 0 and blocked.all.random[3] == 0


def test_equal_independent_names_do_not_become_chain_targets_or_hits():
    h = History(meals=(meal(0, 1, brand=None, qid=None, name="China Garden"),
                       meal(1, 2, brand=None, qid=None, name="China Garden")))
    result = ev.evaluate_chains(h, QuizPrior())
    assert result.all.n == 0 and result.no_identity == 2 and result.chain_meals == 0


def test_report_keeps_exact_metric_and_labels_chain_metric_and_denominators():
    h = History(meals=(meal(0, 1), meal(1, 2), meal(2, 3, brand=None, qid=None)))
    run = ev.evaluate(h, QuizPrior(), "Synthetic", "Synthetic only.")
    report = ev.render_report(h, [run], "synthetic fixtures", D0)
    assert "n = 3 meals at resolved places." in report
    assert "Chain-level place (secondary)" in report
    assert "n = 2 meals at identified chains with known meal slots." in report
    assert "without chain identity: 1 (excluded)" in report
    assert "including unknown slots: 2" in report
    assert "denominator differs from exact-place" in report
