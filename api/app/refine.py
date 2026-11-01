"""Answer changes (P1-21 FR5, P1-14 FR9b, ML10): one shape for chips and parsed text.

A Change is what a quick chip or a Muse-parsed message means: absolute values ("$$", "Thai")
or steps from the current values ("cheaper", "closer", "something else"). apply() turns it
into the next round's constraints. Pure functions, no I/O; the engine re-scores the result
deterministically. Muse only fills a Change, never places (R2).
"""

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.categories import CATEGORY_IDS, OTHER
from app.places import distance_m

if TYPE_CHECKING:
    from app.funnel import ShownCard

ANYTHING = "anything"
RADII = (1500, 5000, 15000)  # FR3 distance chips: Walk, Short drive, Worth the drive
MIN_BUDGET, MAX_BUDGET = 1, 4
DEFAULT_BUDGET = 2
CRAVINGS: tuple[str, ...] = tuple(c for c in CATEGORY_IDS if c != OTHER)

Budget = Literal[1, 2, 3, 4, "cheaper", "pricier"]
Distance = Literal[1500, 5000, 15000, "closer", "farther"]


def known_categories(values: list[str]) -> list[str]:
    """Deduped, in order. ValueError on an unknown id or Other."""
    out: list[str] = []
    for value in values:
        if value not in CRAVINGS:
            raise ValueError("unknown category")
        if value not in out:
            out.append(value)
    return out


class Change(BaseModel):
    """What one answer changes. Fields left at their defaults change nothing."""

    model_config = ConfigDict(extra="forbid")

    craving: str | None = None  # category id or "anything"; None = not mentioned
    exclude_categories: list[str] = Field(default_factory=list, max_length=len(CRAVINGS))
    budget: Budget | None = None
    distance: Distance | None = None
    something_else: bool = False

    @field_validator("craving")
    @classmethod
    def known_craving(cls, value: str | None) -> str | None:
        if value is not None and value != ANYTHING and value not in CRAVINGS:
            raise ValueError("unknown category")
        return value

    @field_validator("exclude_categories")
    @classmethod
    def known_excludes(cls, values: list[str]) -> list[str]:
        return known_categories(values)

    def is_empty(self) -> bool:
        return self == Change()


@dataclass(frozen=True)
class Answers:
    """The constraints a round runs with."""

    craving: str | None
    budget_level: int | None
    radius_m: int | None
    exclude_categories: tuple[str, ...] = ()


@dataclass(frozen=True)
class Applied:
    answers: Answers
    tags: tuple[str, ...]  # what changed, for the rejected events' reason (never user text)


def step_budget(level: int | None, delta: int) -> int:
    base = level if level is not None else DEFAULT_BUDGET
    return max(MIN_BUDGET, min(MAX_BUDGET, base + delta))


def step_radius(radius: int | None, delta: int, default: int) -> int:
    base = radius if radius in RADII else min(RADII, key=lambda r: abs(r - default))
    i = RADII.index(base) + delta
    return RADII[max(0, min(len(RADII) - 1, i))]


def apply(change: Change, current: Answers, default_radius: int) -> Applied:
    """Order: something else (on the current craving), then a named craving, then excludes.

    Something else with no craving ("anything") keeps the settings: the shown places are
    skipped anyway, so the next round is new places with the same answers.
    """
    craving = current.craving
    excludes = list(current.exclude_categories)
    budget, radius = current.budget_level, current.radius_m
    tags: list[str] = []

    if change.something_else:
        tags.append("something_else")
        if craving is not None:
            excludes.append(craving)
            craving = None
    if change.craving == ANYTHING:
        craving = None
        tags.append("craving:anything")
    elif change.craving is not None:
        craving = change.craving
        if craving in excludes:
            excludes.remove(craving)
        tags.append(f"craving:{craving}")
    for category in change.exclude_categories:
        tags.append(f"not:{category}")
        if category not in excludes:
            excludes.append(category)
        if craving == category:
            craving = None

    if change.budget == "cheaper":
        budget = step_budget(budget, -1)
        tags.append("cheaper")
    elif change.budget == "pricier":
        budget = step_budget(budget, 1)
        tags.append("pricier")
    elif change.budget is not None:
        budget = change.budget
        tags.append(f"budget:{budget}")

    if change.distance == "closer":
        radius = step_radius(radius, -1, default_radius)
        tags.append("closer")
    elif change.distance == "farther":
        radius = step_radius(radius, 1, default_radius)
        tags.append("farther")
    elif change.distance is not None:
        radius = change.distance
        tags.append(f"distance:{radius}")

    return Applied(Answers(craving, budget, radius, tuple(excludes)), tuple(tags))


def reject_reason(tags: tuple[str, ...]) -> str:
    return "refine:" + ",".join(tags) if tags else "refine"


def best_so_far(
    shown: "Iterable[ShownCard]",
    answers: Answers,
    radius_m: int,
    lat: float,
    lon: float,
    known_prices: dict[str, int | None],
    budget_level: int | None,
) -> "list[tuple[ShownCard, int]]":
    """The cap (ML10): shown cards that still fit the current answers, best score first.

    Each place once, at its best score. Dropped: an excluded category, beyond the current
    radius from here, or a known price above the budget (prices come from the user's own
    meals; unknown prices stay). Returns up to 3 (card, distance_m) pairs; fewer if fewer fit.
    """
    best: dict[str, ShownCard] = {}
    for card in shown:
        kept = best.get(card.place_id)
        if kept is None or card.score > kept.score:
            best[card.place_id] = card
    fits = []
    for card in best.values():
        if card.category in answers.exclude_categories:
            continue
        meters = distance_m(lat, lon, card.lat, card.lon)
        if meters > radius_m:
            continue
        price = known_prices.get(card.place_id)
        if price is not None and budget_level is not None and price > budget_level:
            continue
        fits.append((card, meters))
    fits.sort(key=lambda f: (-f[0].score, f[1], f[0].place_id))
    return fits[:3]
