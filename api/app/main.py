from collections.abc import AsyncIterator
from dataclasses import asdict

import httpx2
from fastapi import Depends, FastAPI, HTTPException, Query, status

from app import places
from app.auth import current_user

app = FastAPI(title="What to eat! API")

# FR-R2 upper clamp: 25 miles.
MAX_RADIUS_M = 40_234


async def get_places_client() -> AsyncIterator[httpx2.AsyncClient]:
    async with httpx2.AsyncClient() as client:
        yield client


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/me")
def me(user_id: str = Depends(current_user)) -> dict[str, str]:
    return {"user_id": user_id}


@app.get("/places/search")
async def places_search(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius_m: int | None = Query(default=None, ge=1, le=MAX_RADIUS_M),
    user_id: str = Depends(current_user),
    client: httpx2.AsyncClient = Depends(get_places_client),
) -> dict:
    """Catering places within radius_m (default PLACES_RADIUS_M). Empty list is a 200."""
    try:
        result = await places.search(lat, lon, radius_m, client=client)
    except places.PlacesTimeout:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, "Places search timed out") from None
    except places.PlacesNotConfigured:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Places search is not configured"
        ) from None
    except places.PlacesUpstreamError:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Places search failed") from None
    return {
        "radius_m": result.radius_m,
        "count": len(result.places),
        "truncated": result.truncated,
        "places": [asdict(p) for p in result.places],
    }
