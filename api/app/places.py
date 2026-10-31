"""Geoapify Places search (P1-11): one call per round, catering places around a point.

Never log the API key or the request URL (the key is a query param). Errors carry no
upstream detail beyond the status code.
"""

import logging
import math
from dataclasses import dataclass

import httpx2

from app.categories import map_category
from app.config import MissingSettingError, get_settings

PLACES_URL = "https://api.geoapify.com/v2/places"
# One call per round (NFR4). 1 credit per 20 places returned, so at most 5 credits.
LIMIT = 100
# Includes pub, bar, biergarten, and taproom, which the ML2 mapper sends to Pubs/Bars.
CATEGORIES = "catering"
EARTH_RADIUS_M = 6_371_000
OSM_TYPES = {"n": "node", "w": "way", "r": "relation", "node": "node", "way": "way",
             "relation": "relation"}

logger = logging.getLogger(__name__)


class PlacesError(Exception):
    pass


class PlacesNotConfigured(PlacesError):
    pass


class PlacesTimeout(PlacesError):
    pass


class PlacesUpstreamError(PlacesError):
    pass


@dataclass(frozen=True)
class Candidate:
    id: str  # "node/123", "way/456", "relation/789"; else "geoapify:<place_id>"
    name: str
    lat: float
    lon: float
    distance_m: int
    category: str  # ML2 id from the P1-20 mapper
    geoapify_categories: list[str]
    address: str | None


@dataclass(frozen=True)
class SearchResult:
    radius_m: int
    truncated: bool  # Geoapify hit LIMIT, so farther places inside the radius are missing
    places: list[Candidate]


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    """Haversine distance in whole meters."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(2 * EARTH_RADIUS_M * math.asin(math.sqrt(a)))


def place_key(props: dict) -> str | None:
    """OSM type/id from datasource.raw (stable, re-resolvable via Place Details); else place_id."""
    raw = (props.get("datasource") or {}).get("raw") or {}
    osm_type, osm_id = OSM_TYPES.get(str(raw.get("osm_type", ""))), raw.get("osm_id")
    if osm_type and isinstance(osm_id, int):
        # Relations come back with a negative id in Geoapify's raw block.
        return f"{osm_type}/{abs(osm_id)}"
    place_id = props.get("place_id")
    return f"geoapify:{place_id}" if place_id else None


def parse_feature(feature: dict, lat: float, lon: float) -> Candidate | None:
    """One GeoJSON feature -> Candidate, or None if it has no name, coordinates, or key."""
    props = feature.get("properties") or {}
    name = props.get("name")
    plat, plon = props.get("lat"), props.get("lon")
    key = place_key(props)
    if not isinstance(name, str) or not name.strip() or key is None:
        return None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in (plat, plon)):
        return None
    categories = [c for c in props.get("categories") or [] if isinstance(c, str)]
    name = name.strip()
    return Candidate(
        id=key,
        name=name,
        lat=float(plat),
        lon=float(plon),
        distance_m=distance_m(lat, lon, plat, plon),
        category=map_category(categories, name),
        geoapify_categories=categories,
        address=props.get("formatted") or None,
    )


async def search(
    lat: float, lon: float, radius_m: int | None = None, *, client: httpx2.AsyncClient
) -> SearchResult:
    """Exactly one Geoapify Places call. Returns named places, nearest first, deduped."""
    settings = get_settings()
    try:
        api_key = settings.require("GEOAPIFY_API_KEY")
    except MissingSettingError:
        raise PlacesNotConfigured from None
    radius_m = radius_m or settings.PLACES_RADIUS_M
    params = {
        "categories": CATEGORIES,
        "filter": f"circle:{lon},{lat},{radius_m}",
        "bias": f"proximity:{lon},{lat}",
        "limit": LIMIT,
        "apiKey": api_key,
    }
    # Exceptions are re-raised without their message or cause: both can include the URL.
    try:
        response = await client.get(PLACES_URL, params=params, timeout=settings.PLACES_TIMEOUT_S)
    except httpx2.TimeoutException:
        raise PlacesTimeout from None
    except httpx2.HTTPError:
        logger.warning("Geoapify request failed")
        raise PlacesUpstreamError from None
    if response.status_code != 200:
        logger.warning("Geoapify returned status %s", response.status_code)
        raise PlacesUpstreamError
    try:
        features = response.json()["features"]
        if not isinstance(features, list):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        logger.warning("Geoapify returned an unreadable body")
        raise PlacesUpstreamError from None

    places: list[Candidate] = []
    seen_keys: set[str] = set()
    seen_spots: set[tuple[str, float, float]] = set()
    for feature in features:
        if not isinstance(feature, dict) or (place := parse_feature(feature, lat, lon)) is None:
            continue
        # Same OSM object twice, or the same name at the same spot (~1 m).
        spot = (place.name.lower(), round(place.lat, 5), round(place.lon, 5))
        if place.id in seen_keys or spot in seen_spots:
            continue
        seen_keys.add(place.id)
        seen_spots.add(spot)
        places.append(place)
    # Id breaks distance ties so the same results always come back in the same order.
    places.sort(key=lambda p: (p.distance_m, p.id))
    return SearchResult(radius_m=radius_m, truncated=len(features) >= LIMIT, places=places)
