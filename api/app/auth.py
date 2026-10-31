import logging
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import get_settings

# Supabase signs access tokens with the project's asymmetric key (ES256; RS256 also accepted).
ALGORITHMS = ["ES256", "RS256"]
AUDIENCE = "authenticated"
# Supabase caches its JWKS for 10 minutes; caching longer makes key revocation slow.
JWKS_LIFESPAN_SECONDS = 600
# Tolerates small clock skew between Supabase and this server on iat, nbf, and exp.
LEEWAY_SECONDS = 30

logger = logging.getLogger(__name__)

bearer = HTTPBearer(auto_error=False)


@lru_cache
def jwks_client() -> jwt.PyJWKClient:
    url = get_settings().require("SUPABASE_URL").rstrip("/")
    # An unknown kid triggers a refetch, so rotated keys are picked up before the cache expires.
    return jwt.PyJWKClient(
        f"{url}/auth/v1/.well-known/jwks.json", lifespan=JWKS_LIFESPAN_SECONDS, timeout=5
    )


def unauthorized() -> HTTPException:
    # Never include the token or the decode error message in the response or logs.
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid token",
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> tuple[str, str]:
    """Verifies the Supabase access token. Returns (user id, token) for reads as the user."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise unauthorized()
    token = credentials.credentials
    issuer = f"{get_settings().require('SUPABASE_URL').rstrip('/')}/auth/v1"
    try:
        key = jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            key,
            algorithms=ALGORITHMS,
            audience=AUDIENCE,
            issuer=issuer,
            leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "aud", "iss", "sub"]},
        )
    except jwt.PyJWTError as error:
        # The class alone (e.g. ImmatureSignatureError) says why without leaking claims.
        logger.warning("Auth failed: %s", type(error).__name__)
        raise unauthorized() from None
    return claims["sub"], token


def current_user(auth: tuple[str, str] = Depends(current_auth)) -> str:
    """The verified user id (sub)."""
    return auth[0]
