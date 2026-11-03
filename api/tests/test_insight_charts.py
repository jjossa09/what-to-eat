"""P2-08 chart contracts. Synthetic rows only; no database or external service calls."""

import re
from decimal import Decimal
from pathlib import Path

import pytest
from test_insights import AS_OF, USER, A, B, Upstream, get, meal, settings  # noqa: F401

from app.categories import CATEGORY_IDS
from app.companion_metrics import aggregate
from app.insights import _meal


def row(n, *, source="backfill", slot="dinner", **fields):
    result = meal(n, on=fields.pop("eaten_on", "2026-11-02"),
                  source=source, went=True if source == "live" else None,
                  food=source == "live")
    result.update(meal_slot=slot, **fields)
    return result


def section(body, key, slot="dinner"):
    return next(item for item in body[key] if item["meal_slot"] == slot)


def test_i1_price_levels_paid_budget_and_missing():
    # Use the existing SQL boundary constants; the API reads its generated price_level.
    schema = Path("../supabase/migrations/20261028120000_schema.sql").read_text()
    boundaries = [Decimal(value) for value in re.findall(r"when price_amount <=? (\d+)", schema)]
    low, middle, high = boundaries
    amounts = [(low - Decimal("0.01"), 1), (low, 2), (middle, 2),
               (middle + Decimal("0.01"), 3), (high, 3), (high + Decimal("0.01"), 4)]
    rows = [row(i + 1, price_amount=str(amount), price_level=level)
            for i, (amount, level) in enumerate(amounts)]
    rows += [row(10, source="live", price_tap=2, price_level=2, budget_level=4),
             row(11, source="live", budget_level=3), row(12, source="live")]
    body = get(Upstream(rows)).json()
    assert body["complete"] is True
    assert section(body, "price_by_slot") == {
        "meal_slot": "dinner", "levels": [
            {"level": 1, "paid_count": 1, "budget_count": 0},
            {"level": 2, "paid_count": 3, "budget_count": 0},
            {"level": 3, "paid_count": 2, "budget_count": 1},
            {"level": 4, "paid_count": 1, "budget_count": 0}], "missing_meal_count": 1}
    assert body["coverage"]["missing_price_meals"] == 1


def test_i2_distance_odd_even_zero_and_exclusions():
    rows = [row(i + 1, source="live", distance_m=distance)
            for i, distance in enumerate((1000, 3000, 8000))]
    body = get(Upstream(rows)).json()
    assert section(body, "distance_by_slot") == {
        "meal_slot": "dinner", "median_m": 3000, "measured_meal_count": 3}
    rows += [row(4, source="live", distance_m=0), row(5), row(6, source="live")]
    body = get(Upstream(rows)).json()
    assert section(body, "distance_by_slot") == {
        "meal_slot": "dinner", "median_m": 2000, "measured_meal_count": 4}
    assert body["coverage"]["backfill_distance_meals"] == 1
    assert body["coverage"]["missing_distance_meals"] == 1


def test_i3_tied_food_leaders_in_canonical_order():
    rows = [row(i + 1, slot="lunch", category_id=cat)
            for i, cat in enumerate(("thai", "thai", "pizza", "pizza"))]
    body = get(Upstream(rows)).json()
    assert section(body, "food_by_slot", "lunch") == {
        "meal_slot": "lunch", "category_meal_count": 4,
        "leaders": [{"category_id": "pizza", "meal_count": 2},
                    {"category_id": "thai", "meal_count": 2}]}


def test_i4_top_five_includes_boundary_ties_and_group_meal_counts_once():
    rows = []
    for cat, count in zip(CATEGORY_IDS[:6], (6, 5, 4, 3, 2, 2), strict=True):
        for _ in range(count):
            rows.append(row(len(rows) + 1, category_id=cat,
                            meal_companions=[{"companion_id": A}, {"companion_id": B}]))
    body = get(Upstream(rows, companions=(A, B))).json()
    assert body["top_categories"] == [
        {"category_id": cat, "meal_count": count}
        for cat, count in zip(CATEGORY_IDS[:6], (6, 5, 4, 3, 2, 2), strict=True)]
    assert body["summary"] == {"meal_count": 22, "category_meal_count": 22}


def test_i5_unconfirmed_live_meals_appear_in_no_chart():
    invalid = [row(1, source="live", went=None, price_tap=2, distance_m=1000),
               row(2, source="live", went=False, price_tap=2, distance_m=1000)]
    assert get(Upstream(invalid)).json() == get(Upstream()).json()


def test_i6_malformed_price_only_omits_price():
    bad = row(1, source="live", price_tap="bad", distance_m=1000)
    body = get(Upstream([bad])).json()
    assert body["complete"] is False
    assert section(body, "price_by_slot")["missing_meal_count"] == 1
    assert body["coverage"]["missing_price_meals"] == 1
    assert body["companions"]["companions"][0]["meal_count"] == 1
    assert body["top_categories"] == [{"category_id": "thai", "meal_count": 1}]
    assert section(body, "distance_by_slot")["median_m"] == 1000


def test_i7_exactly_two_parallel_supabase_reads_no_places_or_muse():
    upstream = Upstream([row(1)])
    assert get(upstream).status_code == 200
    assert len(upstream.requests) == upstream.max_active == 2
    assert {request.url.path for request in upstream.requests} == {
        "/rest/v1/meals", "/rest/v1/companions"}


def test_i8_companions_unchanged_and_no_private_text():
    rows = [row(1), row(2, source="live"), row(3, solo=True),
            row(4, meal_companions=[])]
    rows[0].update(dish="Private dish", messages="Private message")
    upstream = Upstream(rows)
    upstream.companions[0]["name"] = "Private companion"
    response = get(upstream)
    body = response.json()
    assert body["companions"] == aggregate([A], [_meal(r, USER) for r in rows], AS_OF)
    assert "Private" not in response.text
    for request in upstream.requests:
        assert all(word not in request.url.params["select"] for word in ("name", "dish", "message"))


@pytest.mark.parametrize("bad", [-1, 1.5, True, "1000"])
def test_malformed_distance_keeps_other_measurements(bad):
    body = get(Upstream([row(1, source="live", distance_m=bad, price_tap=2)])).json()
    assert body["complete"] is False
    assert body["summary"]["meal_count"] == 1
    assert body["coverage"]["missing_distance_meals"] == 1
    assert section(body, "price_by_slot")["levels"][1]["paid_count"] == 1
    assert section(body, "distance_by_slot")["median_m"] is None


def test_unknown_slot_omitted_only_from_slot_charts():
    body = get(Upstream([row(1, slot=None, price_amount="15", price_level=2)])).json()
    assert body["coverage"]["unknown_slot_meals"] == 1
    assert body["summary"]["meal_count"] == 1
    assert body["top_categories"] == [{"category_id": "thai", "meal_count": 1}]
    assert body["companions"]["companions"][0]["meal_count"] == 1
    assert all(s["category_meal_count"] == 0 for s in body["food_by_slot"])
    assert all(sum(p["paid_count"] + p["budget_count"] for p in s["levels"]) == 0
               for s in body["price_by_slot"])


def test_cutoff_inclusive_and_empty_sections():
    rows = [row(1, eaten_on="2026-11-04"), row(2, eaten_on="2026-11-05")]
    body = get(Upstream(rows)).json()
    assert body["summary"]["meal_count"] == 1
    assert body["top_categories"] == [{"category_id": "thai", "meal_count": 1}]
    empty = get(Upstream()).json()
    assert empty["summary"] == {"meal_count": 0, "category_meal_count": 0}
    assert empty["top_categories"] == []
    assert all(s["median_m"] is None for s in empty["distance_by_slot"])


def test_company_share_counts_visits_once_excludes_contradictions_and_uses_cutoff():
    rows = [row(i, meal_companions=[]) for i in range(1, 27)]
    for i, companions in enumerate(((A, B), (A, B), (A,), (B,))):
        rows[i]["meal_companions"] = [{"companion_id": cid} for cid in companions]
    rows[4] = row(5, source="live")
    rows[5] = row(6, solo=True)  # Contradictory visit stays in the visit total, not company.
    rows[6] = row(7, solo=True, meal_companions=[])
    rows[7] = row(8, source="live", eaten_on="2026-11-04", meal_companions=[])
    rows += [row(30, source="live", went=None), row(31, source="live", went=False),
             row(32, eaten_on="2026-11-05")]
    body = get(Upstream(rows, companions=(A, B))).json()
    assert body["summary"]["meal_count"] == 26
    assert body["companions"]["with_company_meal_count"] == 5
    people = {c["companion_id"]: c["meal_count"] for c in body["companions"]["companions"]}
    assert people == {A: 4, B: 3}  # Summing participation would incorrectly give seven.
    assert body["companions"]["coverage"] == {
        "unlinked_meals": 20, "contradictory_company_meals": 1}
    assert get(Upstream()).json()["companions"]["with_company_meal_count"] == 0


def test_company_share_uses_surviving_saved_companions():
    body = get(Upstream([row(1)], companions=(B,))).json()
    assert body["companions"]["with_company_meal_count"] == 0
    assert body["companions"]["coverage"]["unlinked_meals"] == 1
