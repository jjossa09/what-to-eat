import asyncio
import json

import httpx2
import pytest
from fastapi.testclient import TestClient

from app import places
from app.auth import current_user
from app.config import get_settings
from app.main import app, get_places_client

LAT, LON = 33.95, -84.55
TEST_KEY = "test-geoapify-key"


@pytest.fixture(autouse=True)
def geoapify_env(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", TEST_KEY)
    monkeypatch.setenv("PLACES_RADIUS_M", "5000")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
    app.dependency_overrides.clear()


def feature(name, lat=33.951, lon=-84.551, categories=("catering", "catering.restaurant"),
            osm_type="n", osm_id=1, place_id="pid", **props) -> dict:
    raw = {} if osm_type is None else {"osm_type": osm_type, "osm_id": osm_id}
    properties = {"name": name, "lat": lat, "lon": lon, "categories": list(categories),
                  "place_id": place_id, "datasource": {"raw": raw}, **props}
    return {"type": "Feature", "properties": properties}


class Upstream:
    """MockTransport handler that records each request."""

    def __init__(self, status=200, body=None, exc=None):
        self.status, self.exc, self.requests = status, exc, []
        self.body = {"type": "FeatureCollection", "features": []} if body is None else body

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.exc:
            raise self.exc
        content = self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()
        return httpx2.Response(self.status, content=content)


def run_search(upstream: Upstream, radius_m=None, bias=False) -> places.SearchResult:
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as client:
            return await places.search(LAT, LON, radius_m, bias=bias, client=client)

    return asyncio.run(go())


def collection(*features) -> dict:
    return {"type": "FeatureCollection", "features": list(features)}


# Service


def test_one_call_with_expected_params():
    upstream = Upstream()
    run_search(upstream)
    assert len(upstream.requests) == 1
    request = upstream.requests[0]
    assert str(request.url).startswith(places.PLACES_URL)
    params = request.url.params
    assert params["categories"] == "catering"
    assert params["filter"] == f"circle:{LON},{LAT},5000"
    assert "bias" not in params  # 5 km default is above the proximity cutoff
    assert params["limit"] == "100"
    assert params["apiKey"] == TEST_KEY


def test_radius_parameter_overrides_default():
    upstream = Upstream()
    result = run_search(upstream, radius_m=1200)
    assert upstream.requests[0].url.params["filter"] == f"circle:{LON},{LAT},1200"
    assert result.radius_m == 1200


def test_normal_response_maps_categories_and_sorts_by_distance():
    upstream = Upstream(body=collection(
        feature("Far Taqueria", lat=33.97, osm_id=3,
                categories=["catering", "catering.restaurant", "catering.restaurant.mexican"]),
        feature("Chipotle Mexican Grill", lat=33.952, osm_type="w", osm_id=2,
                categories=["catering", "catering.fast_food"], formatted="1 Main St"),
        feature("Corner Spot", osm_type="r", osm_id=-7, categories=["catering", "catering.cafe"]),
        feature("Mystery Kitchen", lat=33.96, osm_id=4),
    ))
    result = run_search(upstream)
    assert [p.name for p in result.places] == [
        "Corner Spot", "Chipotle Mexican Grill", "Mystery Kitchen", "Far Taqueria"
    ]
    by_name = {p.name: p for p in result.places}
    assert by_name["Far Taqueria"].category == "mexican"  # cuisine tag
    assert by_name["Chipotle Mexican Grill"].category == "mexican"  # chain
    assert by_name["Corner Spot"].category == "coffee_bakery"  # bare cafe fallback
    assert by_name["Mystery Kitchen"].category == "other"
    assert by_name["Chipotle Mexican Grill"].id == "way/2"
    assert by_name["Chipotle Mexican Grill"].address == "1 Main St"
    assert by_name["Corner Spot"].id == "relation/7"
    assert by_name["Far Taqueria"].id == "node/3"
    assert result.truncated is False


def test_distance_is_haversine_meters():
    # 0.01 degrees of latitude is about 1112 m.
    assert places.distance_m(LAT, LON, LAT + 0.01, LON) == pytest.approx(1112, abs=1)
    result = run_search(Upstream(body=collection(feature("A", lat=LAT + 0.01, lon=LON))))
    assert result.places[0].distance_m == pytest.approx(1112, abs=1)


def test_distance_ties_break_by_id():
    upstream = Upstream(body=collection(
        feature("B", osm_id=2), feature("C", osm_type="w", osm_id=1), feature("A", osm_id=1),
    ))
    assert [p.id for p in run_search(upstream).places] == ["node/1", "node/2", "way/1"]


def test_place_id_fallback_when_osm_ids_missing():
    result = run_search(Upstream(body=collection(feature("A", osm_type=None, place_id="abc"))))
    assert result.places[0].id == "geoapify:abc"


def test_malformed_places_are_dropped():
    upstream = Upstream(body=collection(
        feature(None, osm_id=1),
        feature("   ", osm_id=2),
        feature("No Lat", lat=None, osm_id=3),
        feature("Bad Lon", lon="x", osm_id=4),
        feature("No Key", osm_type=None, place_id=None),
        {"type": "Feature"},
        "not a feature",
        feature("Good", osm_id=9),
    ))
    assert [p.name for p in run_search(upstream).places] == ["Good"]


def test_duplicates_are_dropped():
    upstream = Upstream(body=collection(
        feature("Same Key", osm_id=1),
        feature("Same Key Again", osm_id=1),
        feature("Same Spot", osm_id=2),
        feature("same spot", osm_id=3),
    ))
    assert [p.id for p in run_search(upstream).places] == ["node/1", "node/2"]


def test_empty_result():
    result = run_search(Upstream())
    assert result.places == []
    assert result.truncated is False


def test_truncated_when_limit_reached():
    features = [feature(f"P{i}", osm_id=i) for i in range(places.LIMIT)]
    assert run_search(Upstream(body=collection(*features))).truncated is True


def test_timeout():
    with pytest.raises(places.PlacesTimeout):
        run_search(Upstream(exc=httpx2.ReadTimeout("timed out")))


def test_network_error():
    with pytest.raises(places.PlacesUpstreamError):
        run_search(Upstream(exc=httpx2.ConnectError("refused")))


@pytest.mark.parametrize("status", [401, 429, 500])
def test_non_200(status):
    with pytest.raises(places.PlacesUpstreamError):
        run_search(Upstream(status=status))


@pytest.mark.parametrize("body", [b"not json", {"features": "nope"}, {"type": "x"}, []])
def test_unreadable_body(body):
    with pytest.raises(places.PlacesUpstreamError):
        run_search(Upstream(body=body))


def test_missing_key(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", "")
    get_settings.cache_clear()
    upstream = Upstream()
    with pytest.raises(places.PlacesNotConfigured):
        run_search(upstream)
    assert upstream.requests == []


def test_key_and_url_never_logged(caplog):
    caplog.set_level("DEBUG")
    with pytest.raises(places.PlacesUpstreamError):
        run_search(Upstream(status=500))
    run_search(Upstream(body=collection(feature("A"))))
    assert TEST_KEY not in caplog.text
    assert places.PLACES_URL not in caplog.text


# Route


def use_upstream(upstream: Upstream, user: str | None = "user-1") -> TestClient:
    async def client():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(upstream)) as c:
            yield c

    app.dependency_overrides[get_places_client] = client
    if user:
        app.dependency_overrides[current_user] = lambda: user
    return TestClient(app)


def test_route_requires_auth():
    upstream = Upstream()
    response = use_upstream(upstream, user=None).get(f"/places/search?lat={LAT}&lon={LON}")
    assert response.status_code == 401
    assert upstream.requests == []


def test_route_response_shape():
    upstream = Upstream(body=collection(
        feature("Taqueria Uno", osm_id=5, formatted="2 Elm St",
                categories=["catering", "catering.restaurant"]),
    ))
    response = use_upstream(upstream).get(f"/places/search?lat={LAT}&lon={LON}&radius_m=2000")
    assert response.status_code == 200
    body = response.json()
    assert body["radius_m"] == 2000
    assert body["count"] == 1
    assert body["truncated"] is False
    assert body["places"][0] == {
        "id": "node/5",
        "name": "Taqueria Uno",
        "lat": 33.951,
        "lon": -84.551,
        "distance_m": places.distance_m(LAT, LON, 33.951, -84.551),
        "category": "mexican",
        "geoapify_categories": ["catering", "catering.restaurant"],
        "address": "2 Elm St",
    }


def test_route_empty_is_200():
    response = use_upstream(Upstream()).get(f"/places/search?lat={LAT}&lon={LON}")
    assert response.status_code == 200
    assert response.json() == {"radius_m": 5000, "count": 0, "truncated": False, "places": []}


@pytest.mark.parametrize(
    ("upstream", "status", "detail"),
    [
        (Upstream(exc=httpx2.ReadTimeout("t")), 504, "Places search timed out"),
        (Upstream(status=500), 502, "Places search failed"),
        (Upstream(body=b"<html>"), 502, "Places search failed"),
    ],
)
def test_route_errors(upstream, status, detail):
    response = use_upstream(upstream).get(f"/places/search?lat={LAT}&lon={LON}")
    assert response.status_code == status
    assert response.json() == {"detail": detail}
    assert TEST_KEY not in response.text


def test_route_not_configured(monkeypatch):
    monkeypatch.setenv("GEOAPIFY_API_KEY", "")
    get_settings.cache_clear()
    response = use_upstream(Upstream()).get(f"/places/search?lat={LAT}&lon={LON}")
    assert response.status_code == 503


@pytest.mark.parametrize(
    "query", ["lat=91&lon=0", "lat=0&lon=-181", "lat=0&lon=0&radius_m=0",
              "lat=0&lon=0&radius_m=50000", "lon=0"],
)
def test_route_validation(query):
    upstream = Upstream()
    assert use_upstream(upstream).get(f"/places/search?{query}").status_code == 422
    assert upstream.requests == []


# Proximity bias: always for recommendations (P1-19); the Map tab only for short radii (P1-10)


@pytest.mark.parametrize("radius_m", [15000, 35000])
def test_recommendation_search_is_nearest_first_at_any_radius(radius_m):
    upstream = Upstream()
    run_search(upstream, radius_m=radius_m, bias=True)
    (request,) = upstream.requests
    assert request.url.params["bias"] == f"proximity:{LON},{LAT}"
    assert request.url.params["limit"] == "100"  # still one call, at most 5 credits


@pytest.mark.parametrize("radius_m", [1500, places.PROXIMITY_MAX_RADIUS_M])
def test_short_radius_keeps_proximity_bias(radius_m):
    upstream = Upstream()
    result = run_search(upstream, radius_m=radius_m)
    (request,) = upstream.requests
    assert request.url.params["bias"] == f"proximity:{LON},{LAT}"
    assert request.url.params["filter"] == f"circle:{LON},{LAT},{radius_m}"
    assert result.radius_m == radius_m


@pytest.mark.parametrize("radius_m", [places.PROXIMITY_MAX_RADIUS_M + 1, 5000, 15000])
def test_wide_radius_drops_bias_still_one_call(radius_m):
    upstream = Upstream()
    result = run_search(upstream, radius_m=radius_m)
    (request,) = upstream.requests
    assert "bias" not in request.url.params
    assert request.url.params["filter"] == f"circle:{LON},{LAT},{radius_m}"
    assert request.url.params["limit"] == "100"
    assert result.radius_m == radius_m


def test_wide_radius_results_are_sorted_and_truncation_kept():
    far = [feature(f"Far {i}", lat=LAT + 0.05 - i * 0.0004, osm_id=i, place_id=f"p{i}")
           for i in range(places.LIMIT)]
    result = run_search(Upstream(body=collection(*far)), radius_m=15000)
    assert result.truncated is True
    distances = [p.distance_m for p in result.places]
    assert distances == sorted(distances)
