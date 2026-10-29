import re
from pathlib import Path

import pytest

from app.categories import CATEGORY_IDS, keyword_pattern, map_category, match_category
from app.category_rules import CHAINS, CUISINE_TAGS, EXACT_NAMES, GENERIC_TAGS, NAME_KEYWORDS

MIGRATIONS = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def seeded_ids() -> set[str]:
    # Every row inserted into public.categories, across all migrations.
    ids = set()
    for path in MIGRATIONS.glob("*.sql"):
        sql = path.read_text()
        for insert in re.findall(r"insert into public\.categories.*?;", sql, re.S):
            ids |= set(re.findall(r"\('([a-z_]+)', '", insert))
    return ids


# Tables and seed stay in sync.


def test_category_ids_match_seed():
    assert set(CATEGORY_IDS) == seeded_ids()
    assert len(CATEGORY_IDS) == 25


def test_every_table_slug_is_seeded():
    slugs = (
        [slug for _, slug in CUISINE_TAGS]
        + list(EXACT_NAMES.values())
        + list(CHAINS.values())
        + [slug for slug, _ in NAME_KEYWORDS]
        + [slug for _, slug in GENERIC_TAGS]
    )
    assert set(slugs) <= seeded_ids() - {"other"}


def test_no_duplicate_tags():
    tags = [tag for tag, _ in CUISINE_TAGS]
    assert len(tags) == len(set(tags))


def test_every_ml2_slug_is_reachable():
    reached = {slug for _, slug in CUISINE_TAGS} | {slug for slug, _ in NAME_KEYWORDS}
    assert reached == set(CATEGORY_IDS) - {"other"}
    assert map_category([], "") == "other"


# Overrides: exact names beat tags.


@pytest.mark.parametrize("name,slug", EXACT_NAMES.items())
def test_exact_name(name, slug):
    assert match_category(["catering.restaurant"], name) == (slug, "exact_name", name)


def test_exact_name_beats_cuisine_tag():
    tags = ["catering", "catering.restaurant", "catering.restaurant.american"]
    assert match_category(tags, "PONKO Chicken") == ("chicken_wings", "exact_name", "PONKO Chicken")
    assert map_category(tags, "Ponko Chicken") == "chicken_wings"
    assert map_category(tags, "PONKO Chicken Kennesaw") == "american_diner"  # whole name only


def test_thaicoon_is_thai_not_sushi():
    tags = ["catering.restaurant", "catering.restaurant.sushi"]
    assert map_category(tags, "Thaicoon & Sushi Bar") == "thai"
    assert map_category([], "THAICOON and Sushi Bar") != "thai"  # exact name only


# Pass 1: every cuisine tag.


@pytest.mark.parametrize("tag,slug", CUISINE_TAGS)
def test_cuisine_tag(tag, slug):
    assert match_category(["catering", "catering.restaurant", tag], "Some Place") == (
        slug,
        "cuisine_tag",
        tag,
    )


def test_cuisine_tag_wins_over_name():
    assert map_category(["catering.restaurant.italian"], "Taco Pizza Burger") == "italian"


def test_silla_del_toro_tapas_is_not_mexican():
    tags = ["catering", "catering.restaurant", "catering.restaurant.tapas"]
    assert map_category(tags, "Silla del Toro") == "mediterranean"
    assert map_category(["catering.restaurant"], "Silla del Toro") == "other"


def test_tapas_and_french_tags():
    assert map_category(["catering.fast_food.tapas"], "") == "mediterranean"
    assert map_category(["catering.restaurant.french"], "") == "french"


def test_several_cuisine_tags_use_table_order():
    # National cuisine beats dish type, regardless of input order.
    tags = ["catering.restaurant.burger", "catering.restaurant.mexican"]
    assert map_category(tags, "") == "mexican"
    assert map_category(list(reversed(tags)), "") == "mexican"


def test_pub_and_bar_tags_are_pubs_bars():
    assert map_category(["catering", "catering.pub"], "Two Birds Taphouse") == "pubs_bars"
    assert map_category(["catering", "catering.bar"], "Owlz Pub") == "pubs_bars"
    assert map_category(["catering", "catering.biergarten"], "Der Biergarten") == "pubs_bars"
    assert map_category(["catering", "catering.taproom"], "Burnt Hickory Brewery") == "pubs_bars"
    # Tags still beat keywords.
    assert map_category(["catering", "catering.pub"], "KB's Grill & Burger Pub") == "pubs_bars"


@pytest.mark.parametrize(
    "venue", ["catering.pub", "catering.bar", "catering.biergarten", "catering.taproom"]
)
def test_cuisine_tag_beats_drinking_venue_tag(venue):
    assert map_category([venue, "catering.restaurant.barbecue"], "Hawg & Ale") == "bbq"
    assert map_category([venue, "catering.restaurant.german"], "Bavarian Hall") == "pubs_bars"


def test_generic_tags_fall_through_to_name():
    tags = ["catering.restaurant", "catering.restaurant.regional", "catering.restaurant.asian"]
    assert match_category(tags, "Pho Hoa").source == "keyword"
    assert map_category(tags, "Pho Hoa") == "vietnamese"


# Pass 2: chains, keywords, generic tags.


@pytest.mark.parametrize("name,slug", CHAINS.items())
def test_chain(name, slug):
    assert match_category(["catering.fast_food"], name) == (slug, "chain", name)


@pytest.mark.parametrize(
    "name,slug",
    [
        ("Cook Out", "burgers"),
        ("Chipotle Mexican Grill", "mexican"),
        ("CHICK FIL A", "chicken_wings"),
        ("McDonalds", "burgers"),
        ("Zoes Kitchen", "mediterranean"),
        ("Tropical Smoothie Cafe", "smoothies_juice"),
        ("Starbucks Coffee", "coffee_bakery"),
        ("Playa Bowls", "smoothies_juice"),
    ],
)
def test_chain_name_variants(name, slug):
    assert map_category([], name) == slug


def test_chain_needs_whole_leading_words():
    assert match_category([], "Subwayside Grill").source != "chain"
    assert match_category([], "The Subway Cafe").source != "chain"


def test_chains_before_keywords():
    assert map_category([], "Chicken Salad Chick") == "sandwiches"
    assert map_category([], "Taco Mac") == "chicken_wings"


def test_tropical_smoothie_is_not_coffee_bakery():
    tags = ["catering", "catering.cafe"]
    assert map_category(tags, "Tropical Smoothie Cafe") == "smoothies_juice"


@pytest.mark.parametrize("slug,keyword", [(slug, kw) for slug, kws in NAME_KEYWORDS for kw in kws])
def test_keyword(slug, keyword):
    name = "Joe's " + keyword.removesuffix("*").title() + " Place"
    assert match_category(["catering.restaurant"], name) == (slug, "keyword", keyword)


def test_keyword_stems_are_long_enough():
    for _, keywords in NAME_KEYWORDS:
        for keyword in keywords:
            keyword_pattern(keyword)  # raises if a "*" stem is 4 letters or fewer
    with pytest.raises(ValueError):
        keyword_pattern("pho*")


@pytest.mark.parametrize(
    "name,slug",
    [
        ("Arepas Venezuelan Kitchen", "latin"),
        ("La Venezuelana", "latin"),
        ("Teriyaki Madness", "japanese_sushi"),
        ("Tokyo Teryaki", "japanese_sushi"),
        ("Taqueria del Sol", "mexican"),
        ("Le Petit Café Français", "other"),  # "francais" is not "french"
        ("French Market Grille", "french"),
        ("Crêpe Bistro", "french"),
        ("Sessions Brasserie", "other"),  # "brasserie" is too loose in the US
        ("Tapas 21", "mediterranean"),
        ("Clean Juice", "smoothies_juice"),
        ("Kung Fu Tea Bubble Tea", "smoothies_juice"),
        ("Boba Life", "smoothies_juice"),
        ("Pho 24", "vietnamese"),
        ("D'Cuban Cafe", "latin"),
        ("Golden Krust Caribbean Restautant", "latin"),
        ("Burgers & Wings", "burgers"),  # ML2 order decides between keywords
    ],
)
def test_keyword_examples(name, slug):
    assert map_category(["catering.restaurant"], name) == slug


@pytest.mark.parametrize(
    "name",
    [
        "Phoenix Grill",  # pho
        "Photo Cafe Lounge",  # pho
        "Thaiphoon",  # thai (only the exact-name list catches Thai near-words)
        "Tacoma Station",  # taco
        "Deliverance Tavern",  # deli
        "Delicious Eats",  # deli
        "Poker Room Kitchen",  # poke
        "Wingate Hotel Restaurant",  # wing
        "Gyrotonic Studio",  # gyro
        "Bobaland Arcade",  # boba
        "Fishers Landing",  # fish
        "Subsidiary Lounge",  # subs
        "Indiana Tavern",  # indian
        "Greektown Square",  # greek
        "Currys Hall",  # curry
        "Bbqueen Lounge",  # bbq
    ],
)
def test_short_keywords_match_whole_words_only(name):
    assert map_category(["catering.restaurant"], name) == "other"


def test_bubble_tea_is_smoothies_juice():
    tags = ["catering", "catering.cafe", "catering.cafe.bubble_tea"]
    assert map_category(tags, "Sharetea") == "smoothies_juice"
    assert map_category(["catering.cafe"], "Bubble Tea House") == "smoothies_juice"


def test_bare_cafe_falls_back_to_coffee_bakery_after_name_rules():
    assert match_category(["catering", "catering.cafe"], "Corner Spot") == (
        "coffee_bakery",
        "generic_tag",
        "catering.cafe",
    )
    assert map_category(["catering.cafe"], "Corner Spot Smoothies") == "smoothies_juice"


# Fallback.


@pytest.mark.parametrize(
    "categories,name",
    [
        ([], None),
        ([], ""),
        (["catering.restaurant"], "Unnamed"),
        (["catering.food_court"], "Food Court"),
        (["something.unknown"], "!!!"),
    ],
)
def test_unknown_is_other(categories, name):
    assert match_category(categories, name) == ("other", "none", None)


def test_always_one_valid_id():
    assert map_category(["catering.restaurant.uzbek"], "Samarkand") in CATEGORY_IDS
