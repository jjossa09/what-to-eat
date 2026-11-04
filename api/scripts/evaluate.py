"""P2-13 (ML9): offline evaluation by time-ordered replay. Local only, never deployed.

Run from api/:
    uv run python -m scripts.evaluate                    # live: your meals, read as you
    uv run python -m scripts.evaluate --csv data/backfill.csv [--resolutions PATH]
    [--out docs/EVALUATION.md]
Relative paths are from the repo root. The report holds aggregates only: no place names,
dates, companions, or prices (the repo is public).

No parameter is changed or searched by this script. The models run unchanged
(cuisine_model.predict, place_model.place_scores, scoring.category_fit) with the values in
app/scoring_rules.py, fixed before this replay (ML9). The report lists them.

Replay: meals in (eaten_on, slot) order. Each meal is predicted with as_of = its own eaten_on
and its own slot and weekday/weekend, so it sees only meals from earlier days, never the same
day or later. Baselines and the place pool follow the same rule.
  Cuisine: meals with a countable category (backfill, or live with a food answer).
  Place: meals at resolved places. Pool = places visited on earlier days, minus hard-no
    categories (as in scoring.rank). Score = the engine's category and return terms,
    renormalized over those two weights. Distance and price are left out: backfill has no
    location. A first visit to a new place is a miss.
  Baselines: most frequent so far (raw counts, ties alphabetical; never uses the quiz) and
    random, computed analytically from the same allowed set the model ranks.
  Runs: strict cold start (no quiz prior, uniform), then the user's quiz prior on the same
    meals; under the quiz prior a meal in a hard-no category is a miss.

Auth (live): the same as import_backfill: BACKFILL_EMAIL from api/.env, password typed at the
prompt, the user's JWT with the anon key, so RLS applies. The token is never printed or saved.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import math
import sys
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import httpx2
import jwt

from app import history as history_api
from app.categories import map_category
from app.cuisine_model import PREDICTABLE, counts, is_weekend, predict
from app.place_model import is_visit, place_scores
from app.scoring import Context, History, PastMeal, QuizPrior, StoredPlace, category_fit
from app.scoring_rules import (
    FAMILIARITY_SCALE,
    HALF_LIFE_DAYS,
    LEVEL_MIN_N_EFF,
    QUIZ_FAVORITES_MASS,
    SCORE_DIGITS,
    SMOOTHING_K,
    STAR_FACTOR,
    STAR_UNKNOWN,
    WEIGHTS,
)
from scripts.import_backfill import (
    DEFAULT_CSV,
    DEFAULT_RESOLUTIONS,
    TIMEOUT_S,
    ImportFailed,
    ImportSettings,
    Resolved,
    load_resolutions,
    local_today,
    need,
    parse_csv,
    print_errors,
    repo_path,
    secret,
    sign_in,
)

DEFAULT_OUT = Path("docs/EVALUATION.md")
SLOT_ORDER = ("breakfast", "lunch", "dinner", "late")
KS = (1, 3)
TOP_N = max(KS)
Z95 = 1.959963984540054
MIN_SLOT_N = 3  # per-slot rows need at least this many meals
EVER = date.max  # as_of that keeps every past meal: "would this meal count at all"
NO_HARD_NOS: frozenset[str] = frozenset()

W_CAT, W_RET = WEIGHTS["category"], WEIGHTS["return"]


# Replay ----------------------------------------------------------------------


def replay_order(meals: Iterable[PastMeal]) -> list[PastMeal]:
    def key(m: PastMeal) -> tuple[date, int]:
        slot = SLOT_ORDER.index(m.meal_slot) if m.meal_slot in SLOT_ORDER else len(SLOT_ORDER)
        return m.eaten_on, slot

    return sorted(meals, key=key)


def context_of(meal: PastMeal) -> Context:
    """The meal's own context. Only meal_slot and is_weekend are read by predict()."""
    return Context(lat=0.0, lon=0.0, local_date=meal.eaten_on, meal_slot=meal.meal_slot,
                   is_weekend=is_weekend(meal), search_radius_m=1)


def cuisine_targets(meals: Iterable[PastMeal]) -> list[PastMeal]:
    """Meals with a countable category and a slot, in replay order. Same set in every run."""
    return [m for m in replay_order(meals)
            if m.meal_slot in SLOT_ORDER and counts(m, EVER, NO_HARD_NOS)]


def place_targets(meals: Iterable[PastMeal]) -> list[PastMeal]:
    """Visits to resolved places with a slot, in replay order."""
    return [m for m in replay_order(meals) if m.meal_slot in SLOT_ORDER and is_visit(m, EVER)]


def top(scores: dict[str, float], k: int = TOP_N) -> list[str]:
    """Highest first, ties by id. Rounded so float noise never decides a tie."""
    return sorted(scores, key=lambda x: (-round(scores[x], SCORE_DIGITS), x))[:k]


# Results ---------------------------------------------------------------------


@dataclass
class Hits:
    """Observed hits per k for the model and most-frequent baseline, plus the random
    baseline's expected hits (a sum of exact per-meal probabilities, never sampled)."""

    n: int = 0
    model: Counter = field(default_factory=Counter)
    frequent: Counter = field(default_factory=Counter)
    random: dict[int, float] = field(default_factory=lambda: dict.fromkeys(KS, 0.0))

    def add(self, actual: str, model: list[str], frequent: list[str], allowed: int,
            in_allowed: bool) -> None:
        self.n += 1
        for k in KS:
            self.model[k] += actual in model[:k]
            self.frequent[k] += actual in frequent[:k]
            if in_allowed and allowed:
                self.random[k] += min(k, allowed) / allowed


@dataclass
class CuisineResult:
    all: Hits
    by_slot: dict[str, Hits]
    allowed: int  # categories the model may predict
    hard_no_misses: int  # meals in a hard-no category (automatic misses)
    # Top-3 disagreements with the most-frequent baseline (for the Diagnosis section).
    model_only: int = 0  # model hit, baseline missed
    frequent_only: int = 0  # baseline hit, model missed
    disagree_n_eff: list[float] = field(default_factory=list)  # n_eff at the reported level

    def slot_rows(self) -> list[tuple[str, Hits]]:
        return [(s, self.by_slot[s]) for s in SLOT_ORDER
                if s in self.by_slot and self.by_slot[s].n >= MIN_SLOT_N]


@dataclass
class PlaceResult:
    all: Hits
    repeat: Hits  # visits to a place seen on an earlier day
    new_place: int  # first visits (misses)
    hard_no_misses: int  # repeat visits to a place in a hard-no category (not in the pool)


def evaluate_cuisine(history: History, prior: QuizPrior) -> CuisineResult:
    h = History(prior=prior, meals=history.meals)
    allowed = [c for c in PREDICTABLE if c not in prior.hard_nos]
    result = CuisineResult(Hits(), {}, len(allowed), 0)
    for m in cuisine_targets(history.meals):
        as_of = m.eaten_on
        prediction = predict(h, context_of(m), as_of)
        model = top({c: prediction.probs[c] for c in allowed})
        seen = Counter(e.category_id for e in history.meals if counts(e, as_of, NO_HARD_NOS))
        frequent = top({c: seen[c] for c in PREDICTABLE})
        in_allowed = m.category_id not in prior.hard_nos
        result.hard_no_misses += not in_allowed
        for hits in (result.all, result.by_slot.setdefault(m.meal_slot, Hits())):
            hits.add(m.category_id, model, frequent, len(allowed), in_allowed)
        model_hit, frequent_hit = m.category_id in model[:3], m.category_id in frequent[:3]
        if model_hit != frequent_hit:
            result.model_only += model_hit
            result.frequent_only += frequent_hit
            result.disagree_n_eff.append(prediction.n_eff)
    return result


def place_category(place: StoredPlace) -> str:
    return map_category(place.geoapify_categories, place.name)


def evaluate_places(history: History, prior: QuizPrior) -> PlaceResult:
    h = History(prior=prior, meals=history.meals)
    result = PlaceResult(Hits(), Hits(), 0, 0)
    for m in place_targets(history.meals):
        as_of = m.eaten_on
        earlier = [e for e in history.meals if is_visit(e, as_of)]
        seen: dict[str, StoredPlace] = {e.place.id: e.place for e in earlier}
        visits = Counter(e.place.id for e in earlier)
        pool = {pid: cat for pid, p in seen.items()
                if (cat := place_category(p)) not in prior.hard_nos}
        returns = place_scores(h, as_of)
        prediction = predict(h, context_of(m), as_of)
        scores = {
            pid: (W_CAT * category_fit(cat, prediction)[0] + W_RET * returns[pid].return_score)
            / (W_CAT + W_RET)
            for pid, cat in pool.items()
        }
        model = top(scores)
        frequent = top(dict(visits))
        new = m.place.id not in seen
        in_pool = m.place.id in pool
        result.new_place += new
        result.hard_no_misses += not new and not in_pool
        for hits in (result.all,) if new else (result.all, result.repeat):
            hits.add(m.place.id, model, frequent, len(pool), in_pool)
    return result


@dataclass(frozen=True)
class Run:
    title: str
    note: str
    prior: QuizPrior
    cuisine: CuisineResult
    places: PlaceResult


def evaluate(history: History, prior: QuizPrior, title: str, note: str) -> Run:
    return Run(title, note, prior, evaluate_cuisine(history, prior),
               evaluate_places(history, prior))


# Statistics ------------------------------------------------------------------


def wilson(hits: int, n: int, z: float = Z95) -> tuple[float, float] | None:
    """95% Wilson score interval for an observed rate; None when n = 0."""
    if n == 0:
        return None
    p = hits / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, center - half), min(1.0, center + half)


# Report ----------------------------------------------------------------------


def pct(x: float) -> str:
    return f"{100 * x:.1f}%"


def observed(hits: int, n: int) -> str:
    ci = wilson(hits, n)
    if ci is None:
        return "n/a (n = 0)"
    return f"{pct(hits / n)} ({hits}/{n}), CI {pct(ci[0])} to {pct(ci[1])}"


def expected(total: float, n: int) -> str:
    return "n/a (n = 0)" if n == 0 else f"{pct(total / n)} expected (analytic)"


def rate_table(hits: Hits) -> list[str]:
    rows = [
        "| Method | Top-1 | Top-3 |",
        "|---|---|---|",
        "| Model | " + " | ".join(observed(hits.model[k], hits.n) for k in KS) + " |",
        "| Most frequent so far | "
        + " | ".join(observed(hits.frequent[k], hits.n) for k in KS) + " |",
        "| Random | " + " | ".join(expected(hits.random[k], hits.n) for k in KS) + " |",
    ]
    return rows


def render_run(run: Run) -> list[str]:
    c, p = run.cuisine, run.places
    lines = [f"## {run.title}", "", run.note, ""]
    if run.prior.favorites or run.prior.hard_nos:
        lines += [f"Quiz prior: {len(run.prior.favorites)} favorite categories, "
                  f"{len(run.prior.hard_nos)} hard-no categories.", ""]
    lines += [
        "### Cuisine",
        "",
        f"n = {c.all.n} meals. The model may predict {c.allowed} categories. "
        f"Meals in a hard-no category (automatic misses): {c.hard_no_misses}.",
        "",
        *rate_table(c.all),
        "",
        f"Top-3 by meal slot (slots with n >= {MIN_SLOT_N}):",
        "",
    ]
    slot_rows = c.slot_rows()
    if slot_rows:
        lines += ["| Slot | n | Model | Most frequent so far | Random |", "|---|---|---|---|---|"]
        for slot, hits in slot_rows:
            lines.append(f"| {slot} | {hits.n} | {observed(hits.model[3], hits.n)} | "
                         f"{observed(hits.frequent[3], hits.n)} | "
                         f"{expected(hits.random[3], hits.n)} |")
    else:
        lines.append("No slot has enough meals.")
    repeat_n = p.repeat.n
    lines += [
        "",
        "### Place",
        "",
        f"n = {p.all.n} meals at resolved places. "
        f"New-place share: {observed(p.new_place, p.all.n)}. "
        f"Repeat visits to a hard-no place (not in the pool, misses): {p.hard_no_misses}.",
        "",
        "All visits (a first visit to a new place is a miss):",
        "",
        *rate_table(p.all),
        "",
        f"Repeat visits only (n = {repeat_n}):",
        "",
        *rate_table(p.repeat),
        "",
    ]
    return lines


def render_diagnosis(run: Run) -> list[str]:
    """Cuisine top-3 disagreements between the model and the baseline. Aggregates only."""
    c = run.cuisine
    lines = ["## Diagnosis", ""]
    if not c.disagree_n_eff:
        return lines + [f"{run.title}, cuisine top-3: the model and the most-frequent baseline "
                        "agree on every meal.", ""]
    lo, hi = min(c.disagree_n_eff), max(c.disagree_n_eff)
    return lines + [
        f"- {run.title}, cuisine top-3: the model and the most-frequent baseline differ on "
        f"{len(c.disagree_n_eff)} of {c.all.n} meals ({c.frequent_only} baseline hits, "
        f"{c.model_only} model hits). On those meals the model's reported context held "
        f"{lo:.1f} to {hi:.1f} recency-weighted meals.",
        "- Cause, found meal by meal on the backfill replay: the context levels (meal slot, "
        "then weekday/weekend) split a thin history, so a single meal can move a category in "
        "or out of the top 3. The baseline pools every meal and avoids that noise.",
        "- Not a bug: an independent reimplementation of the ML3 formula matches "
        "`predict()` to float precision, and the leakage test (no same-day or later meals) "
        "passes (`api/tests/test_evaluate.py`). Model ties and hard no's played no part.",
        "",
    ]


def data_summary(history: History) -> list[str]:
    meals = history.meals
    sources = Counter(m.source for m in meals)
    no_slot = sum(m.meal_slot not in SLOT_ORDER and counts(m, EVER, NO_HARD_NOS) for m in meals)
    unresolved = sum(m.place is None for m in meals)
    days = (max(m.eaten_on for m in meals) - min(m.eaten_on for m in meals)).days + 1 if meals \
        else 0
    return [
        f"- Meals loaded: {len(meals)} ({sources['backfill']} backfill, {sources['live']} live"
        + (f", {sources['chat']} chat" if sources['chat'] else "") + "), "
        f"spanning {days} days.",
        f"- Meals at unresolved places (cuisine only, not place): {unresolved}.",
        f"- Countable meals skipped for having no meal slot: {no_slot}.",
    ]


def render_report(history: History, runs: list[Run], source: str, generated: date) -> str:
    stars = ", ".join(f"{s}: {STAR_FACTOR[s]}" for s in sorted(STAR_FACTOR, reverse=True))
    lines = [
        "# Offline evaluation (ML9, P2-13)",
        "",
        f"Generated {generated.isoformat()} by `api/scripts/evaluate.py` from {source}. "
        "Aggregates only.",
        "",
        "## Method",
        "",
        "- Time-ordered replay: meals in (date, meal slot) order. Each meal is predicted with "
        "only meals from earlier days (as_of = its own date), with its own meal slot and "
        "weekday/weekend. Same-day and later meals are never seen.",
        "- The real models run unchanged: `cuisine_model.predict`, `place_model.place_scores`, "
        "`scoring.category_fit`. No parameter was changed or searched by this evaluation; the "
        "values below were fixed before the replay.",
        "- Cuisine: meals with a countable category (backfill, or live with a food answer). "
        "A hit is the eaten category in the model's top 1 or top 3. Ties: alphabetical.",
        "- Place: meals at resolved places. Candidate pool = places visited on earlier days, "
        "minus hard-no categories (as in the app). Score = "
        f"({W_CAT} x category fit + {W_RET} x return score) / {W_CAT + W_RET:.2f}, the "
        "engine's own category and return terms renormalized over those two weights. "
        "Distance and price are excluded because backfill has no location. A first visit to "
        "a new place is a miss. Ties: place id.",
        "- Baselines on the same meals: most frequent so far (raw counts of earlier meals, ties "
        "alphabetical, never uses the quiz) and random, computed analytically, not sampled: "
        "k / allowed categories for cuisine, k / pool size for place, averaged over meals "
        "(0 when the eaten category or place is not in the allowed set).",
        "- Observed rates show a 95% Wilson interval (CI). Random rates are exact expected "
        "values, so they have no interval.",
        "",
        "## Parameters (app/scoring_rules.py)",
        "",
        f"- WEIGHTS: category {W_CAT}, return {W_RET} (price {WEIGHTS['price']} and distance "
        f"{WEIGHTS['distance']} not used here)",
        f"- HALF_LIFE_DAYS {HALF_LIFE_DAYS}, SMOOTHING_K {SMOOTHING_K}, "
        f"QUIZ_FAVORITES_MASS {QUIZ_FAVORITES_MASS}, LEVEL_MIN_N_EFF {LEVEL_MIN_N_EFF}",
        f"- FAMILIARITY_SCALE {FAMILIARITY_SCALE}, STAR_UNKNOWN {STAR_UNKNOWN}, "
        f"STAR_FACTOR {stars}",
        f"- SCORE_DIGITS {SCORE_DIGITS}",
        "",
        "## Data",
        "",
        *data_summary(history),
        "",
    ]
    for run in runs:
        lines += render_run(run)
    lines += render_diagnosis(runs[0])
    lines += [
        "## Limitations",
        "",
        "- Small n: intervals are wide; differences inside overlapping intervals are not "
        "evidence of a real difference.",
        "- One user. Nothing here generalizes to other people.",
        "- Backfill was entered from memory, so dates, slots, and categories may have errors.",
        "- No location in backfill: distance and price fit "
        f"({WEIGHTS['distance'] + WEIGHTS['price']:.2f} of the live score's weight) are not "
        "evaluated. The place ranking here is the category and return terms only.",
        "- Backfill has no stars, so star factors are untested (every visited place uses "
        "STAR_UNKNOWN).",
        "",
    ]
    return "\n".join(lines)


# Loading ---------------------------------------------------------------------


def stored_place(r: Resolved) -> StoredPlace:
    return StoredPlace(id=r.id, name=r.name, lat=r.lat, lon=r.lon,
                       geoapify_categories=r.geoapify_categories, address=r.address)


def load_csv(csv_path: Path, resolutions_path: Path) -> History:
    """Offline mode: the backfill CSV plus saved place choices. No quiz prior, no network."""
    try:
        with csv_path.open(encoding="utf-8-sig", newline="") as f:
            rows, errors = parse_csv(f, local_today(datetime.now()))
    except OSError as e:
        raise ImportFailed(f"can't read {csv_path}: {e.strerror}") from None
    if errors:
        print_errors(errors)
        raise ImportFailed(f"{len(errors)} problem(s) in {csv_path}")
    resolutions = load_resolutions(resolutions_path)
    missing = {r.place_key for r in rows} - resolutions.keys()
    if missing:
        raise ImportFailed(f"{len(missing)} place(s) not in {resolutions_path}; "
                           "run scripts.import_backfill first")
    meals = []
    for row in rows:
        res = resolutions[row.place_key]
        meals.append(PastMeal(
            place=stored_place(res) if isinstance(res, Resolved) else None,
            eaten_on=row.eaten_on,
            source="backfill",
            category_id=row.category_id,
            price_level=None,  # not used by this evaluation
            meal_slot=row.meal_slot,
        ))
    return History(meals=tuple(meals))


def load_live() -> History:
    """Signs in as BACKFILL_EMAIL and loads history the same way the API does."""
    settings = ImportSettings()
    need(settings, "SUPABASE_URL", "SUPABASE_ANON_KEY", "BACKFILL_EMAIL")
    base = settings.SUPABASE_URL.rstrip("/")
    anon = secret(settings.SUPABASE_ANON_KEY)
    password = getpass.getpass(f"Password for {settings.BACKFILL_EMAIL}: ")
    with httpx2.Client(timeout=TIMEOUT_S) as client:
        token = sign_in(client, base, anon, settings.BACKFILL_EMAIL, password)
    del password
    try:
        # Read only to get the user id: the token came from Supabase over HTTPS just now.
        user_id = jwt.decode(token, options={"verify_signature": False})["sub"]
    except (jwt.PyJWTError, KeyError):
        raise ImportFailed("sign-in returned an unreadable token") from None

    async def fetch() -> History:
        async with httpx2.AsyncClient() as client:
            return await history_api.load(user_id, token, client=client)

    try:
        history = asyncio.run(fetch())
    except history_api.HistoryError as e:
        raise ImportFailed(f"history load failed ({type(e).__name__})") from None
    if len(history.meals) >= history_api.MEALS_LIMIT:
        print(f"Warning: {history_api.MEALS_LIMIT} meals loaded, the read cap; older meals are "
              "missing.", file=sys.stderr)
    return history


# Main ------------------------------------------------------------------------

COLD_NOTE = ("No quiz prior: level 0 is uniform over all predictable categories. Only "
             "earlier meals inform each prediction.")
QUIZ_NOTE = ("Uses the user's actual quiz prior (favorites and hard no's). This is "
             "information the user gave after the backfill period, so this run is optimistic "
             "for the earliest meals. Same meals as the cold start run.")
NO_QUIZ_NOTE = " No quiz prior is on file, so this run equals the cold start run."
CSV_NOTE = "CSV mode has no quiz prior, so only the strict cold start run is reported."


def build_runs(history: History, with_quiz: bool) -> list[Run]:
    cold_note = COLD_NOTE if with_quiz else f"{COLD_NOTE} {CSV_NOTE}"
    runs = [evaluate(history, QuizPrior(), "Run A: strict cold start", cold_note)]
    if with_quiz:
        prior = history.prior
        note = QUIZ_NOTE + ("" if prior.favorites or prior.hard_nos else NO_QUIZ_NOTE)
        runs.append(evaluate(history, prior,
                             "Run B: with the quiz prior (given after the backfill period)", note))
    return runs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Replay history and write docs/EVALUATION.md.")
    parser.add_argument("--csv", type=Path, help="offline mode: evaluate this backfill CSV")
    parser.add_argument("--resolutions", type=Path, default=DEFAULT_RESOLUTIONS,
                        help="place choices for --csv")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    try:
        if args.csv:
            history = load_csv(repo_path(args.csv), repo_path(args.resolutions))
            source = f"the backfill CSV ({DEFAULT_CSV.name} format, offline mode)"
        else:
            history = load_live()
            source = "the user's meals in Supabase (live mode)"
    except ImportFailed as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        return 130
    report = render_report(history, build_runs(history, with_quiz=not args.csv), source,
                           date.today())
    out = repo_path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
