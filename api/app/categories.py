"""Deterministic Geoapify place -> ML2 category mapping (P1-20).

Pure functions, no I/O. Tables are in app/category_rules.py. Input is what the places
table stores (geoapify_categories and name), so stored places can be re-mapped.
"""

import re
import unicodedata
from collections.abc import Iterable
from typing import NamedTuple

from app.category_rules import CHAINS, CUISINE_TAGS, EXACT_NAMES, GENERIC_TAGS, NAME_KEYWORDS

# The 24 ML2 categories plus Other, as seeded in supabase/migrations.
CATEGORY_IDS: tuple[str, ...] = (
    "burgers",
    "pizza",
    "mexican",
    "latin",
    "chinese",
    "japanese_sushi",
    "korean",
    "thai",
    "vietnamese",
    "indian",
    "mediterranean",
    "italian",
    "french",
    "american_diner",
    "bbq",
    "chicken_wings",
    "sandwiches",
    "seafood",
    "salads_bowls",
    "breakfast_brunch",
    "coffee_bakery",
    "smoothies_juice",
    "dessert",
    "pubs_bars",
    "other",
)
OTHER = "other"


class CategoryMatch(NamedTuple):
    category: str
    source: str  # "cuisine_tag", "exact_name", "chain", "keyword", "generic_tag", "none"
    rule: str | None  # the tag, name, or keyword that matched


def normalize(text: str) -> str:
    """Lowercase, no accents, possessive 's kept as s, other punctuation as single spaces."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    # "McDonald's" -> "mcdonalds", but "D'Cuban" -> "d cuban".
    text = re.sub(r"['’`](?=s\b)", "", text)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text).split())


def keyword_pattern(keyword: str) -> re.Pattern[str]:
    # "word" = whole word; "stem*" = a word starting with stem (stems over 4 letters only).
    stem = keyword.removesuffix("*")
    words = normalize(stem).split()
    if keyword.endswith("*") and len(words[-1]) <= 4:
        raise ValueError(f"stem {keyword!r} is too short for a word-start match")
    end = r"[a-z0-9]*\b" if keyword.endswith("*") else r"\b"
    return re.compile(r"\b" + r" ".join(map(re.escape, words)) + end)


_EXACT_NAMES = {normalize(name): slug for name, slug in EXACT_NAMES.items()}
# Longest first, so a longer chain name wins over a shorter one it starts with.
_CHAINS = sorted(
    ((normalize(name), name, slug) for name, slug in CHAINS.items()),
    key=lambda chain: -len(chain[0]),
)
_KEYWORDS = [
    (slug, keyword, keyword_pattern(keyword))
    for slug, keywords in NAME_KEYWORDS
    for keyword in keywords
]


def match_category(categories: Iterable[str], name: str | None) -> CategoryMatch:
    """Maps a Geoapify place to exactly one ML2 category and says which rule decided it."""
    tags = set(categories)
    normalized = normalize(name or "")
    # Overrides: human-verified exact names beat everything.
    if normalized in _EXACT_NAMES:
        return CategoryMatch(_EXACT_NAMES[normalized], "exact_name", name)

    # Pass 1: an existing cuisine tag always wins over the name.
    for tag, slug in CUISINE_TAGS:
        if tag in tags:
            return CategoryMatch(slug, "cuisine_tag", tag)

    # Pass 2: chains, then keywords, then generic tags.
    if normalized:
        for chain, original, slug in _CHAINS:
            if normalized == chain or normalized.startswith(chain + " "):
                return CategoryMatch(slug, "chain", original)
        for slug, keyword, pattern in _KEYWORDS:
            if pattern.search(normalized):
                return CategoryMatch(slug, "keyword", keyword)
    for tag, slug in GENERIC_TAGS:
        if tag in tags:
            return CategoryMatch(slug, "generic_tag", tag)
    return CategoryMatch(OTHER, "none", None)


def map_category(categories: Iterable[str], name: str | None) -> str:
    """Geoapify categories + name -> one ML2 category id (never None)."""
    return match_category(categories, name).category
