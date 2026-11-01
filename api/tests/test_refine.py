import pytest

from app.refine import Answers, Change, apply, reject_reason

NOW = Answers(craving="thai", budget_level=2, radius_m=5000)
ANY = Answers(craving=None, budget_level=2, radius_m=5000)


def run(change: Change, current: Answers = NOW):
    return apply(change, current, default_radius=5000)


@pytest.mark.parametrize("change, budget, radius", [
    (Change(budget="cheaper"), 1, 5000),
    (Change(budget="pricier"), 3, 5000),
    (Change(budget=4), 4, 5000),
    (Change(distance="closer"), 2, 1500),
    (Change(distance="farther"), 2, 15000),
    (Change(distance=1500), 2, 1500),
])
def test_steps_and_values(change, budget, radius):
    answers = run(change).answers
    assert (answers.budget_level, answers.radius_m, answers.craving) == (budget, radius, "thai")


def test_steps_stop_at_the_ends():
    low = Answers(craving=None, budget_level=1, radius_m=1500)
    high = Answers(craving=None, budget_level=4, radius_m=15000)
    assert run(Change(budget="cheaper", distance="closer"), low).answers == low
    assert run(Change(budget="pricier", distance="farther"), high).answers == high


def test_steps_from_unset_values_use_defaults():
    blank = Answers(craving=None, budget_level=None, radius_m=None)
    answers = run(Change(budget="cheaper", distance="closer"), blank).answers
    assert (answers.budget_level, answers.radius_m) == (1, 1500)


def test_something_else_excludes_the_craving():
    applied = run(Change(something_else=True))
    assert applied.answers == Answers(None, 2, 5000, ("thai",))
    assert applied.tags == ("something_else",)


def test_something_else_with_anything_keeps_the_settings():
    applied = run(Change(something_else=True), ANY)
    assert applied.answers == ANY
    assert reject_reason(applied.tags) == "refine:something_else"


def test_not_the_craving_clears_it():
    answers = run(Change(exclude_categories=["thai", "burgers"])).answers
    assert answers.craving is None and answers.exclude_categories == ("thai", "burgers")


def test_naming_an_excluded_category_brings_it_back():
    current = Answers("pizza", 2, 5000, ("burgers", "thai"))
    answers = run(Change(craving="thai"), current).answers
    assert answers.craving == "thai" and answers.exclude_categories == ("burgers",)


def test_something_else_then_a_new_craving():
    answers = run(Change(something_else=True, craving="korean")).answers
    assert answers.craving == "korean" and answers.exclude_categories == ("thai",)


def test_anything_clears_the_craving_without_excluding_it():
    assert run(Change(craving="anything")).answers == ANY


def test_tags_never_hold_free_text():
    applied = run(Change(budget="cheaper", exclude_categories=["burgers"], distance=1500))
    assert reject_reason(applied.tags) == "refine:not:burgers,cheaper,distance:1500"
    assert reject_reason(()) == "refine"


def test_no_duplicate_excludes():
    current = Answers(None, 2, 5000, ("burgers",))
    assert run(Change(exclude_categories=["burgers"]), current).answers.exclude_categories == (
        "burgers",)
