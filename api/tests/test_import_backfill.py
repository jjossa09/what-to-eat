import io
import json
from datetime import date, datetime
from decimal import Decimal

import httpx2
import pytest

from app.places import Candidate
from scripts import import_backfill as ib

TODAY = date(2026, 11, 1)
HEADER = "date,meal_slot,place,category,price,companions,dish\n"


def parse(body: str, header: str = HEADER, today: date = TODAY):
    return ib.parse_csv(io.StringIO(header + body), today)


def one(body: str, **kw) -> ib.Row:
    rows, errors = parse(body, **kw)
    assert errors == []
    assert len(rows) == 1
    return rows[0]


def error_messages(body: str, **kw) -> list[str]:
    rows, errors = parse(body, **kw)
    return [str(e) for e in errors]


def candidate(name: str, pid: str = "node/1", tags=("catering.restaurant",)) -> Candidate:
    return Candidate(pid, name, 33.9, -84.5, 1200, "other", list(tags), "1 Test St")


# Dates ------------------------------------------------------------------------


def test_both_date_formats():
    assert one("2026-10-05,lunch,Taco Spot,Mexican,,,\n").eaten_on == date(2026, 10, 5)
    assert one("10/5/2026,lunch,Taco Spot,Mexican,,,\n").eaten_on == date(2026, 10, 5)
    assert one("01/02/2026,lunch,Taco Spot,Mexican,,,\n").eaten_on == date(2026, 1, 2)


@pytest.mark.parametrize("value", ["2026/10/05", "5-10-2026", "2026-02-30", "13/1/2026", ""])
def test_bad_dates(value):
    assert len(error_messages(f"{value},lunch,Taco Spot,Mexican,,,\n")) == 1


def test_future_date_rejected():
    assert one("2026-11-01,lunch,Taco Spot,Mexican,,,\n").eaten_on == TODAY
    (msg,) = error_messages("2026-11-02,lunch,Taco Spot,Mexican,,,\n")
    assert "future" in msg


def test_before_5am_today_is_still_yesterday():
    assert ib.local_today(datetime(2026, 11, 2, 3, 0)) == date(2026, 11, 1)
    assert ib.local_today(datetime(2026, 11, 2, 5, 0)) == date(2026, 11, 2)
    late_today = ib.local_today(datetime(2026, 11, 2, 3, 0))
    assert error_messages("2026-11-02,late,Taco Spot,Mexican,,,\n", today=late_today)


# Slot and category -------------------------------------------------------------


def test_slot():
    assert one("2026-10-05, Dinner ,Taco Spot,Mexican,,,\n").meal_slot == "dinner"
    assert "blank" in error_messages("2026-10-05,,Taco Spot,Mexican,,,\n")[0]
    assert error_messages("2026-10-05,brunch,Taco Spot,Mexican,,,\n")


@pytest.mark.parametrize("value, slug", [
    ("mexican", "mexican"),
    ("MEXICAN", "mexican"),
    ("Japanese/Sushi", "japanese_sushi"),
    ("japanese_sushi", "japanese_sushi"),
    (" chicken/wings ", "chicken_wings"),
])
def test_category_slug_or_display_name(value, slug):
    assert one(f"2026-10-05,lunch,Taco Spot,{value},,,\n").category_id == slug


@pytest.mark.parametrize("value", ["other", "Other", "tapas", ""])
def test_category_rejected(value):
    assert error_messages(f"2026-10-05,lunch,Taco Spot,{value},,,\n")


# Price -------------------------------------------------------------------------


@pytest.mark.parametrize("value, amount", [
    ("", None),
    ("12", Decimal("12")),
    ("12.5", Decimal("12.5")),
    ("12.50", Decimal("12.50")),
    ('"$17.70 "', Decimal("17.70")),
    ("$ 3", Decimal("3")),
    ("0", Decimal("0")),
    ("99999.99", Decimal("99999.99")),
])
def test_price(value, amount):
    assert one(f"2026-10-05,lunch,Taco Spot,Mexican,{value},,\n").price_amount == amount


@pytest.mark.parametrize("value", ["-1", "$-1", "1.234", "100000", "abc", "$", "1,200", "1e3"])
def test_bad_price(value):
    assert error_messages(f'2026-10-05,lunch,Taco Spot,Mexican,"{value}",,\n')


# Companions --------------------------------------------------------------------


def test_companions():
    row = one("2026-10-05,lunch,Taco Spot,Mexican,,solo,\n")
    assert (row.solo, row.companions) == (True, ())
    row = one("2026-10-05,lunch,Taco Spot,Mexican,,,\n")
    assert (row.solo, row.companions) == (None, ())
    row = one("2026-10-05,lunch,Taco Spot,Mexican,, Ana ;bob; ana ;;Bob,\n")
    assert (row.solo, row.companions) == (False, ("Ana", "bob"))


@pytest.mark.parametrize("value", [";", "solo;Ana", "x" * 41])
def test_bad_companions(value):
    assert error_messages(f"2026-10-05,lunch,Taco Spot,Mexican,,{value},\n")


# Dish --------------------------------------------------------------------------


def test_dish():
    assert one("2026-10-05,lunch,Taco Spot,Mexican,,,  al pastor  \n").dish == "al pastor"
    assert one("2026-10-05,lunch,Taco Spot,Mexican,,,   \n").dish is None
    assert one(f"2026-10-05,lunch,Taco Spot,Mexican,,,{'x' * 60}\n").dish == "x" * 60
    (msg,) = error_messages(f"2026-10-05,lunch,Taco Spot,Mexican,,,{'x' * 61}\n")
    assert "61" in msg


def test_dish_accents_count_as_one_character():
    composed = "é" * 60
    decomposed = "é" * 60  # same text, 120 code points before NFC
    assert one(f"2026-10-05,lunch,Taco Spot,Mexican,,,{composed}\n").dish == composed
    assert one(f"2026-10-05,lunch,Taco Spot,Mexican,,,{decomposed}\n").dish == composed
    assert error_messages(f"2026-10-05,lunch,Taco Spot,Mexican,,,{'é' * 61}\n")


def test_six_column_file():
    header = "date,meal_slot,place,category,price,companions\n"
    row = one("2026-10-05,lunch,Taco Spot,Mexican,9.99,solo\n", header=header)
    assert row.dish is None and row.price_amount == Decimal("9.99")


def test_bad_header_and_extra_columns():
    (msg,) = error_messages("x\n", header="date,slot,place\n")
    assert msg.startswith("line 1:")
    assert "too many columns" in error_messages("2026-10-05,lunch,Taco Spot,Mexican,,,,x\n")[0]


# File-level checks ---------------------------------------------------------------


def test_duplicate_rows_flagged():
    body = ("2026-10-05,lunch,Café Uno,Mexican,,,\n"
            "2026-10-05,lunch,cafe uno,Thai,,,\n"
            "2026-10-05,dinner,Cafe Uno,Thai,,,\n")
    rows, errors = parse(body)
    assert [str(e) for e in errors] == ["line 3: same date, slot, and place as line 2"]
    assert len(rows) == 2


def test_every_bad_row_reported_with_line_numbers():
    body = ("2026-10-05,lunch,Taco Spot,Mexican,,,\n"
            "\n"
            "2026-10-06,brunch,Taco Spot,other,,,\n"
            "2026-10-07,lunch,,Mexican,-5,,\n")
    msgs = error_messages(body)
    assert [m.split(":")[0] for m in msgs] == ["line 4", "line 4", "line 5", "line 5"]


def test_blank_lines_skipped():
    rows, errors = parse("2026-10-05,lunch,Taco Spot,Mexican,,,\n,,,,,,\n")
    assert errors == [] and len(rows) == 1


def test_place_name_normalized():
    row = one("2026-10-05,lunch,  Café  Ñandú's ,Mexican,,,\n")
    assert row.place == "Café  Ñandú's"
    assert row.place_key == "cafe nandus"


# backfill_key, clear match, payload ------------------------------------------------


def test_backfill_key():
    row = one("2026-10-05,lunch,Café Uno,Mexican,,,\n")
    resolved = ib.Resolved("node/42", "Cafe Uno", 33.9, -84.5, None, ())
    assert ib.backfill_key(row, resolved) == "2026-10-05|lunch|node/42"
    assert ib.backfill_key(row, ib.Unresolved("Café Uno")) == "2026-10-05|lunch|unresolved:cafe uno"


def test_clear_match_rule():
    assert ib.clear_match("Café Uno", [candidate("Cafe Uno"), candidate("Uno Pizza", "node/2")])
    assert ib.clear_match("cafe uno", [candidate("CAFÉ UNO")]).name == "CAFÉ UNO"
    # Two exact names, none, or no results: ask.
    two = [candidate("Cafe Uno"), candidate("Cafe Uno", "node/2")]
    assert ib.clear_match("Cafe Uno", two) is None
    assert ib.clear_match("Cafe Uno", [candidate("Cafe Uno Express")]) is None
    assert ib.clear_match("Cafe Uno", []) is None


def test_place_categories_never_come_from_csv():
    resolved = ib.Resolved("node/1", "Some Place", 33.9, -84.5, None,
                           ("catering.restaurant.pizza",))
    assert resolved.category_id == "pizza"
    assert ib.Unresolved("Taqueria Luna").category_id == "mexican"
    assert ib.Unresolved("Blue Door").category_id == "other"
    row = one("2026-10-05,lunch,Taqueria Luna,Thai,,,\n")
    payload = ib.row_payload(row, ib.Unresolved("Taqueria Luna"))
    assert payload["category_id"] == "thai"
    assert payload["place"] == {"unresolved": True, "name": "Taqueria Luna",
                                "category_id": "mexican"}


def test_row_payload():
    row = one("2026-10-05,dinner,Slice,Pizza,$17.70,Ana;Bob,pepperoni\n")
    resolved = ib.Resolved("node/7", "Slice", 33.9, -84.5, "2 Test St", ("catering.restaurant",))
    assert ib.row_payload(row, resolved) == {
        "eaten_on": "2026-10-05",
        "meal_slot": "dinner",
        "category_id": "pizza",
        "price_amount": "17.70",
        "solo": False,
        "companions": ["Ana", "Bob"],
        "dish": "pepperoni",
        "backfill_key": "2026-10-05|dinner|node/7",
        "place": {"id": "node/7", "name": "Slice", "lat": 33.9, "lon": -84.5,
                  "address": "2 Test St", "geoapify_categories": ["catering.restaurant"],
                  "category_id": "other"},  # the place's own mapping, not the meal's pizza
    }


def test_duplicate_keys_after_resolution():
    rows, _ = parse("2026-10-05,lunch,Cafe Uno,Thai,,,\n2026-10-05,lunch,Uno Cafe,Thai,,,\n")
    same = ib.Resolved("node/1", "Cafe Uno", 33.9, -84.5, None, ())
    (err,) = ib.duplicate_keys(rows, {"cafe uno": same, "uno cafe": same})
    assert err.line == 3


def test_summary():
    body = ("2026-10-05,lunch,Cafe Uno,Thai,12,Ana;Bob,\n"
            "2026-10-06,lunch,Blue Door,Thai,,solo,\n"
            "2026-10-07,lunch,Cafe Uno,Thai,,Cara,\n")
    rows, _ = parse(body)
    res = {"cafe uno": ib.Resolved("node/1", "Cafe Uno", 33.9, -84.5, None, ()),
           "blue door": ib.Unresolved("Blue Door")}
    s = ib.summary(rows, res, {"2026-10-07|lunch|node/1"}, {"ana"})
    assert s == {"new": 2, "imported": 1, "resolved": 1, "unresolved": 1, "companions": 1,
                 "blank_prices": 2}


# Resolutions file -------------------------------------------------------------------


def test_resolutions_round_trip(tmp_path):
    path = tmp_path / "data" / "backfill_resolutions.json"
    assert ib.load_resolutions(path) == {}
    saved = {
        "cafe uno": ib.Resolved("node/1", "Café Uno", 33.9, -84.5, "1 St", ("catering.cafe",)),
        "blue door": ib.Unresolved("Blue Door"),
    }
    ib.save_resolutions(path, saved)
    assert ib.load_resolutions(path) == saved
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["blue door"] == {"unresolved": True, "name": "Blue Door"}
    assert list(tmp_path.joinpath("data").iterdir()) == [path]  # no temp file left


@pytest.mark.parametrize("content", [
    "not json",
    "[]",
    '{"x": {"name": "X"}}',
    '{"x": {"id": "unresolved:1", "name": "X", "lat": 1, "lon": 1}}',
    '{"x": {"id": "node/1", "name": "X", "lat": "1", "lon": 1}}',
])
def test_bad_resolutions_file(tmp_path, content):
    path = tmp_path / "r.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ib.ImportFailed):
        ib.load_resolutions(path)


def test_resolve_places_uses_saved_then_clear_match_then_asks(tmp_path):
    rows, _ = parse("2026-10-05,lunch,Saved Spot,Thai,,,\n"
                    "2026-10-06,lunch,Cafe Uno,Thai,,,\n"
                    "2026-10-07,lunch,Mystery,Thai,,,\n"
                    "2026-10-08,lunch,Pick Me,Thai,,,\n"
                    "2026-10-09,lunch,cafe uno,Thai,,,\n")
    resolutions = {"saved spot": ib.Unresolved("Saved Spot")}
    results = {
        "Cafe Uno": [candidate("Cafe Uno", "node/1")],
        "Mystery": [],
        "Mystery Diner": [],
        "Pick Me": [candidate("Pick Me Up", "node/3"), candidate("Pick Me Express", "node/4")],
    }
    searched, saves = [], []
    answers = iter(["Mystery Diner", "u", "x", "9", "2"])
    out = ib.resolve_places(
        rows, resolutions,
        save=lambda r: saves.append(dict(r)),
        search=lambda q: searched.append(q) or results[q],
        ask=lambda prompt: next(answers),
    )
    assert searched == ["Cafe Uno", "Mystery", "Mystery Diner", "Pick Me"]  # once per name
    assert out["cafe uno"].id == "node/1"
    assert out["mystery"] == ib.Unresolved("Mystery")
    assert out["pick me"].id == "node/4"
    assert len(saves) == 3  # after every choice


# Geoapify search: timeout and one retry ---------------------------------------------


def geoapify_client(outcomes: list):
    """Mock transport: each request takes the next outcome (an exception or features)."""
    requests = []

    def handler(request):
        requests.append(request)
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return httpx2.Response(200, json={"features": outcome})

    return httpx2.Client(transport=httpx2.MockTransport(handler)), requests


FEATURE = {"properties": {
    "name": "Panda Express", "lat": 33.9, "lon": -84.5, "place_id": "p1",
    "datasource": {"raw": {"osm_type": "n", "osm_id": 42}},
    "categories": ["catering.fast_food"], "formatted": "1 Test St",
}}


def test_search_retries_once_on_timeout(capsys):
    client, requests = geoapify_client([httpx2.ReadTimeout("slow"), [FEATURE]])
    (c,) = ib.search_places(client, "test-key", "Panda Express", 33.95, -84.55)
    assert c.id == "node/42"
    assert len(requests) == 2
    params = requests[0].url.params
    assert params["name"] == "Panda Express"
    assert params["filter"] == "circle:-84.55,33.95,50000"
    assert requests[0].extensions["timeout"] == {
        "connect": 5.0, "read": 30.0, "write": 30.0, "pool": 30.0}
    out = capsys.readouterr().out
    assert 'Searching "Panda Express"...' in out
    assert 'Geoapify is slow, retrying "Panda Express"...' in out


def test_search_fails_after_two_timeouts():
    client, requests = geoapify_client([httpx2.ConnectTimeout("x"), httpx2.ReadTimeout("x")])
    with pytest.raises(ib.ImportFailed) as e:
        ib.search_places(client, "test-key", "Panda Express", 33.95, -84.55)
    assert len(requests) == 2
    assert "ReadTimeout" in str(e.value) and "test-key" not in str(e.value)


def test_search_does_not_retry_other_errors():
    client, requests = geoapify_client([httpx2.ConnectError("x"), [FEATURE]])
    with pytest.raises(ib.ImportFailed):
        ib.search_places(client, "test-key", "Panda Express", 33.95, -84.55)
    assert len(requests) == 1
