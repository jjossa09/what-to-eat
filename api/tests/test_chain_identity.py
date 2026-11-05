"""#73 identity, scoring, provider, cache and signed-reason contracts. Synthetic only."""

import json
from dataclasses import replace
from datetime import date, timedelta
from uuid import UUID

import httpx2
import pytest
from test_recommendations import Upstreams, env, feature, post  # noqa: F401
from test_widening import Upstreams as SearchUpstreams

from app import muse, places
from app.chains import ChainResolver, retained_identity
from app.place_model import chain_scores, familiarity, place_scores, star_factor
from app.scoring import (
    Context,
    History,
    PastMeal,
    QuizPrior,
    StoredPlace,
    merge_candidates,
    models_for,
    pick_top3,
    rank,
    score_candidate,
)
from scripts import evaluate, import_backfill

TODAY = date(2026, 11, 4)
TAG = "catering.restaurant.chinese"


def candidate(pid=1, meters=100, category="chinese", *, brand="Synthetic Chain", qid="Q100"):
    tags = [TAG] if category == "chinese" else [f"catering.restaurant.{category}"]
    return places.Candidate(f"node/{pid}", f"Synthetic branch {pid}", 33.95 + meters / 111195,
                            -84.55, meters, category, tags, None, brand, qid)


def ctx(**changes):
    return Context(lat=33.95, lon=-84.55, local_date=TODAY, meal_slot="dinner", is_weekend=False,
                   search_radius_m=15000, **changes)


def visit(place, days=1, stars=5, price=2):
    stored = StoredPlace(place.id, place.name, place.lat, place.lon,
                         tuple(place.geoapify_categories), None, place.brand, place.brand_wikidata)
    return PastMeal(stored, TODAY - timedelta(days=days), "live", "chicken_wings", price,
                    meal_slot="dinner", went=True, food_answered=True, stars=stars)


def shown(place, round_=3, score=.8):
    return {"round": round_, "place_id": place.id, "score": score, "slot": "familiar",
            "places": {"name": place.name, "lat": place.lat, "lon": place.lon,
                       "category_id": place.category,
                       "geoapify_categories": place.geoapify_categories,
                       "brand": place.brand, "brand_wikidata": place.brand_wikidata}}


def test_provider_brand_wikidata_is_distinct_from_the_individual_place_wikidata():
    raw = feature("Synthetic branch", 101, 33.95, [TAG])
    raw["properties"]["datasource"]["raw"].update({
        "brand": "Synthetic Chain", "brand:wikidata": "Q100", "wikidata": "Q999"})
    actual = places.parse_feature(raw, 33.95, -84.55)
    assert actual.brand == "Synthetic Chain" and actual.brand_wikidata == "Q100"
    resolver = ChainResolver([actual])
    assert resolver.key(actual) == "wikidata:Q100"
    del raw["properties"]["datasource"]["raw"]["brand:wikidata"]
    actual = places.parse_feature(raw, 33.95, -84.55)
    assert actual.brand_wikidata is None
    assert ChainResolver().key(actual) == "brand:synthetic chain"


def test_brand_aliases_bridge_missing_metadata_only_with_unique_provider_evidence():
    known = replace(candidate(), name="Panda Express", brand="Panda Express")
    brand_only = replace(known, id="node/2", brand_wikidata=None)
    name_only = replace(known, id="node/3", brand=None, brand_wikidata=None,
                        name="Panda Express Synthetic Branch")
    resolver = ChainResolver([known, brand_only, name_only])
    assert {resolver.key(p) for p in [known, brand_only, name_only]} == {"wikidata:Q100"}
    conflicting = replace(known, id="node/4", brand_wikidata="Q101")
    resolver = ChainResolver([known, conflicting])
    assert resolver.key(known) != resolver.key(conflicting)
    assert resolver.key(brand_only) == "brand:panda express"


def test_wider_result_retains_missing_optional_identity_only_for_the_same_provider_id():
    initial = candidate(1)
    wider = replace(initial, brand=None, brand_wikidata=None, name="Updated synthetic name")
    actual = places.deduplicate([wider, initial])
    assert len(actual) == 1 and actual[0].name == wider.name
    assert actual[0].brand_wikidata == "Q100" and actual[0].brand == "Synthetic Chain"
    unrelated = replace(wider, id="node/2", lat=wider.lat + .01, distance_m=1200)
    by_id = {p.id: p for p in places.deduplicate([unrelated, initial])}
    assert by_id[unrelated.id].brand_wikidata is None


def test_positively_changed_provider_identity_never_inherits_a_conflicting_old_field():
    before = candidate()
    other_brand = replace(before, brand="Other Synthetic Chain", brand_wikidata=None)
    assert retained_identity(other_brand, before) == ("Other Synthetic Chain", None)
    other_qid = replace(before, brand=None, brand_wikidata="Q200")
    assert retained_identity(other_qid, before) == (None, "Q200")


def test_missing_brand_fields_on_an_exact_returned_place_can_use_verified_earlier_identity():
    before = candidate(1, 100)
    returned = replace(before, brand=None, brand_wikidata=None)
    another_branch = candidate(2, 800)
    result = rank([returned, another_branch], ctx(required_craving="chinese"),
                  History(meals=(visit(before),)))
    assert len(result.top3) == 1 and result.top3[0].scored.place.id == returned.id
    assert result.top3[0].scored.evidence.chain_visits == 1


def test_approved_normalized_name_fallback_never_groups_arbitrary_equal_names():
    allowed = replace(candidate(), name="McDonald’s Synthetic Branch", brand=None,
                      brand_wikidata=None)
    assert ChainResolver().key(allowed) == "brand:mcdonalds"
    independent = [replace(candidate(i, i * 100), name="China Garden", brand=None,
                           brand_wikidata=None) for i in (1, 2)]
    assert all(ChainResolver().key(p) is None for p in independent)
    assert len(rank(independent, ctx(), History()).top3) == 2


def test_closest_branch_is_retained_even_when_a_farther_branch_has_a_higher_score():
    near = candidate(1, 100, "italian")
    far = candidate(2, 1500)
    history = History(prior=QuizPrior(favorites=frozenset({"chinese"})))
    context = ctx(craving="chinese")  # soft preference, both categories are eligible
    model = models_for(history, context)
    near_score = score_candidate(near, history, context, {}, frozenset(), model.prediction,
                                 model.usual).score
    far_score = score_candidate(far, history, context, {}, frozenset(), model.prediction,
                                model.usual).score
    assert near_score < far_score
    result = rank([far, near], context, history)
    assert [s.place.id for s in result.ranked] == [near.id]
    assert [p.scored.place.id for p in result.top3] == [near.id]


def test_explicit_cuisine_eligibility_precedes_closest_chain_branch_selection():
    near_wrong = candidate(1, 100, "italian")
    eligible = candidate(2, 800)
    name_only = replace(candidate(3, 50), geoapify_categories=["catering.restaurant"])
    result = rank([near_wrong, eligible, name_only], ctx(craving="chinese",
                  required_craving="chinese"), History())
    assert [p.scored.place.id for p in result.top3] == [eligible.id]
    assert not rank([eligible], ctx(required_craving="chinese",
        exclude_categories=frozenset({"chinese"})), History()).top3
    assert not rank([eligible], ctx(required_craving="chinese"), History(
        prior=QuizPrior(hard_nos=frozenset({"chinese"})))).top3


def test_history_contributes_evidence_without_substituting_an_unreturned_closer_branch():
    historical = candidate(1, 10)
    returned = candidate(2, 800)
    history = History(meals=(visit(historical),))
    context = ctx(required_craving="chinese")
    pool, merged = merge_candidates([returned], history, context)
    assert historical.id in merged
    result = rank(pool, context, history, merged)
    assert [p.scored.place.id for p in result.top3] == [returned.id]
    evidence = result.top3[0].scored.evidence
    assert evidence.chain_visits == 1 and evidence.visits == 0


def test_chain_history_counts_each_visit_and_rating_once_with_unchanged_formulas():
    first, second, unvisited = candidate(1), candidate(2), candidate(3)
    history = History(meals=(visit(first, 1, 5, 1), visit(second, 2, 3, 3),
                            visit(first, 0, 1, 4), visit(second, -1, 1, 4)))
    resolver = ChainResolver([first, second, unvisited])
    score = chain_scores(history, TODAY, resolver)["wikidata:Q100"]
    exact = place_scores(history, TODAY)
    assert score.visits == 2 and exact[first.id].visits == exact[second.id].visits == 1
    assert score.weighted_visits == pytest.approx(sum(s.weighted_visits for s in exact.values()))
    expected_stars = (sum(s.stars_mean * s.weighted_visits for s in exact.values())
                      / score.weighted_visits)
    assert score.stars_mean == pytest.approx(expected_stars)
    expected_return = familiarity(score.weighted_visits) * star_factor(expected_stars)
    assert score.return_score == pytest.approx(expected_return)
    assert score.known_price_level == 1 and score.last_visit_days == 1
    pick = rank([unvisited], ctx(required_craving="chinese"), history).top3[0]
    assert pick.scored.evidence.visits == 0 and pick.scored.evidence.chain_visits == 2
    assert pick.scored.evidence.chain_stars_mean == score.stars_mean
    assert pick.scored.evidence.known_price_level == 1
    assert history.meals[0].category_id == "chicken_wings"  # food is never relabeled Chinese


def test_future_history_metadata_cannot_establish_a_chain_alias_for_this_round():
    historical = replace(candidate(1), brand_wikidata=None)
    future = candidate(2)
    returned = replace(candidate(3), brand_wikidata=None)
    history = History(meals=(visit(historical), visit(future, -1)))
    context = ctx(required_craving="chinese")
    pool, merged = merge_candidates([returned], history, context)
    evidence = rank(pool, context, history, merged).top3[0].scored.evidence
    assert evidence.chain_id == "brand:synthetic chain" and evidence.chain_visits == 1


def test_low_rated_chain_can_score_below_an_untried_independent_place():
    branch = candidate(1)
    history = History(meals=(visit(branch, stars=1),))
    independent = replace(candidate(2), brand=None, brand_wikidata=None)
    ranked = rank([branch, independent], ctx(required_craving="chinese"), history).ranked
    assert ranked[0].place.id == independent.id
    assert ranked[1].evidence.return_score < 0


def test_chain_template_and_muse_evidence_do_not_claim_the_displayed_location_was_visited():
    first, returned = candidate(1), candidate(2)
    history = History(meals=(visit(first), visit(first, 2)))
    pick = rank([returned], ctx(required_craving="chinese"), history).top3[0]
    line = muse.template_reason(pick)
    assert line.startswith("You've visited Synthetic Chain 2 times,") and "here" not in line
    evidence = muse.pick_evidence(pick)
    assert evidence["visited_before"] is False and evidence["visits"] == 0
    assert evidence["chain"]["visits"] == 2 and evidence["price_scope"] == "chain"
    assert muse.check_output(json.dumps({"reasons": [{"id": returned.id, "line": line}]}),
        [returned.id], never_visited=frozenset({returned.id}), stars={returned.id: None},
        evidence={returned.id: evidence})[returned.id] == line
    for bad in ["You've been here 2 times.", "You've visited this location 2 times.",
                "You've visited Synthetic Chain 8 times.",
                "You've visited Synthetic Chain 2 times, 9.0 mi away.", "Fits your budget."]:
        with pytest.raises(muse.RejectedOutput):
            muse.check_output(json.dumps({"reasons": [{"id": returned.id, "line": bad}]}),
                [returned.id], never_visited=frozenset({returned.id}),
                evidence={returned.id: evidence})


def test_one_exact_branch_visit_cannot_be_reported_as_two_visits_here():
    first, second = candidate(1), candidate(2)
    history = History(meals=(visit(first), visit(second, 2)))
    evidence = muse.pick_evidence(rank([first], ctx(), history).top3[0])
    assert evidence["visits"] == 1 and evidence["chain"]["visits"] == 2
    assert not muse.grounded_reason("You've been here 2 times.", evidence)
    assert muse.grounded_reason("You've visited Synthetic Chain 2 times.", evidence)


def test_signed_rating_evidence_uses_chain_scope_without_inventing_an_exact_branch_rating():
    first, second, returned = candidate(1), candidate(2), candidate(3)
    history = History(meals=(visit(first, 1, 5), visit(second, 2, 3)))
    evidence = muse.pick_evidence(rank([returned], ctx(), history).top3[0])
    assert "stars_mean" not in evidence and evidence["chain"]["stars_mean"] == 4.0
    line = "You rated Synthetic Chain 4 stars."
    checked = muse.check_output(json.dumps({"reasons": [{"id": returned.id, "line": line}]}),
        [returned.id], stars={returned.id: None}, evidence={returned.id: evidence})
    assert checked[returned.id] == line
    with pytest.raises(muse.RejectedOutput):
        muse.check_output(json.dumps({"reasons": [{"id": returned.id,
                          "line": "You rated it 4 stars."}]}), [returned.id],
                          stars={returned.id: None}, evidence={returned.id: evidence})


def test_slot_allocation_and_fallback_never_duplicate_a_chain():
    history = History(prior=QuizPrior(favorites=frozenset({"chinese"})))
    pool = [candidate(1), candidate(2, 200),
            replace(candidate(3, 300, "italian"), brand="Other Chain", brand_wikidata="Q200"),
            replace(candidate(4, 400, "thai"), brand=None, brand_wikidata=None)]
    result = rank(pool, ctx(), history)
    assert len(result.top3) == 3
    assert [p.slot for p in result.top3] == ["familiar", "familiar", "discovery"]
    assert len({p.scored.evidence.chain_id or p.scored.place.id for p in result.top3}) == 3
    # Even a direct slot allocator caller receives the same closest-branch guarantee.
    first = result.ranked[0]
    farther = replace(first, place=replace(first.place, id="node/500", distance_m=5000), score=1.)
    direct = pick_top3((farther, *result.ranked), frozenset({"chinese"}), False)
    assert "node/500" not in [p.scored.place.id for p in direct]


def test_best_so_far_deduplicates_closest_eligible_branches_before_score_sort():
    near, far = candidate(1, 100), candidate(2, 800)
    other = replace(candidate(3, 500), brand=None, brand_wikidata=None)
    up = Upstreams(shown=[shown(near, score=.2), shown(far, score=.9), shown(other, score=.8)])
    response = post(up, session_id=str(UUID(int=1)), craving="chinese", radius_m=15000)
    assert response.status_code == 200 and response.json()["best_so_far"]
    assert [p["id"] for p in response.json()["picks"]] == [other.id, near.id]
    assert up.hosts().count("api.geoapify.com") == 0


def test_widening_counts_distinct_chain_choices_and_preserves_explicit_cuisine():
    pool = []
    for i in range(9):
        item = feature(f"Synthetic branch {i}", 100 + i, 33.951 + i * .001, [TAG])
        item["properties"]["datasource"]["raw"].update({"brand": "Synthetic Chain",
                                                        "brand:wikidata": "Q100"})
        pool.append(item)
    up = SearchUpstreams([pool])
    response = post(up, craving="chinese", radius_m=15000)
    assert response.status_code == 200 and len(response.json()["picks"]) == 1
    assert response.json()["picks"][0]["id"] == "node/100"
    requests = [r for r in up.requests if r.url.host == "api.geoapify.com"]
    assert len(requests) == 3 and all(TAG in r.url.params["categories"] for r in requests)
    cached = [r for r in up.requests if r.method == "POST" and r.url.path.endswith("/places")]
    assert json.loads(cached[0].content)[0]["brand_wikidata"] == "Q100"
    meals_reads = [r for r in up.requests if r.method == "GET" and r.url.path.endswith("/meals")]
    assert len(meals_reads) == 1 and "brand_wikidata" in meals_reads[0].url.params["select"]


def test_backfill_resolution_and_offline_loading_preserve_actual_brand_metadata():
    actual = candidate()
    resolved = import_backfill.Resolved.from_candidate(actual)
    saved = import_backfill.resolution_to_json(resolved)
    assert import_backfill.resolution_from_json(saved) == resolved
    assert import_backfill.place_payload(resolved)["brand_wikidata"] == "Q100"
    stored = evaluate.stored_place(resolved)
    assert ChainResolver([stored]).key(stored) == "wikidata:Q100"
    old = dict(saved)
    old.pop("brand")
    old.pop("brand_wikidata")
    legacy = import_backfill.resolution_from_json(old)
    assert legacy.brand is None and legacy.brand_wikidata is None


@pytest.mark.parametrize("issue", [httpx2.ReadTimeout("synthetic"), 500])
def test_valid_initial_results_survive_widening_failure_with_partial_status(issue):
    up = SearchUpstreams([[feature("Synthetic Chinese", 101, 33.951, [TAG])], issue])
    response = post(up, craving="chinese", radius_m=15000)
    assert response.status_code == 200 and response.json()["picks"]
    assert response.json()["search_status"] == "partial"
    assert response.json()["search_issue"] == ("timeout" if isinstance(issue, Exception)
                                               else "provider_error")


def test_failed_current_search_can_return_eligible_shown_cards_with_an_explicit_cached_label():
    previous = candidate(1)
    wrong = candidate(2, category="italian", qid="Q200")
    up = SearchUpstreams([httpx2.ReadTimeout("synthetic")],
                         shown=[shown(previous, 1), shown(wrong, 1)])
    response = post(up, session_id=str(UUID(int=1)), craving="chinese", radius_m=15000)
    assert response.status_code == 200
    body = response.json()
    assert body["search_status"] == "partial" and body["using_cached"]
    assert body["search_issue"] == "timeout" and not body["best_so_far"]
    assert [p["id"] for p in body["picks"]] == [previous.id]
