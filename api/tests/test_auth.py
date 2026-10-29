import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.auth import jwks_client
from app.config import get_settings
from app.main import app

SUPABASE_URL = "https://test-project.supabase.co"
ISSUER = f"{SUPABASE_URL}/auth/v1"
USER_ID = "00000000-0000-0000-0000-000000000001"
KID = "test-key"

# A signing key made for these tests; the JWKS fetch is patched to return its public half.
SIGNING_KEY = ec.generate_private_key(ec.SECP256R1())
OTHER_KEY = ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(autouse=True)
def supabase_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", SUPABASE_URL)
    get_settings.cache_clear()
    jwks_client.cache_clear()
    public_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(SIGNING_KEY.public_key()))
    public_jwk.update(kid=KID, alg="ES256", use="sig")
    monkeypatch.setattr(jwt.PyJWKClient, "fetch_data", lambda self: {"keys": [public_jwk]})
    yield
    get_settings.cache_clear()
    jwks_client.cache_clear()


def make_token(key=SIGNING_KEY, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": USER_ID,
        "aud": "authenticated",
        "iss": ISSUER,
        "role": "authenticated",
        "iat": now,
        "exp": now + 3600,
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": KID})


def get_me(headers: dict[str, str] | None = None):
    return TestClient(app).get("/me", headers=headers or {})


def test_valid_token():
    response = get_me({"Authorization": f"Bearer {make_token()}"})
    assert response.status_code == 200
    assert response.json() == {"user_id": USER_ID}


def test_no_token():
    response = get_me()
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_malformed_token():
    assert get_me({"Authorization": "Bearer not-a-jwt"}).status_code == 401


def test_not_bearer_scheme():
    assert get_me({"Authorization": f"Basic {make_token()}"}).status_code == 401


def test_expired_token():
    token = make_token(exp=int(time.time()) - 60)
    assert get_me({"Authorization": f"Bearer {token}"}).status_code == 401


def test_wrong_audience():
    token = make_token(aud="anon")
    assert get_me({"Authorization": f"Bearer {token}"}).status_code == 401


def test_wrong_issuer():
    token = make_token(iss="https://other-project.supabase.co/auth/v1")
    assert get_me({"Authorization": f"Bearer {token}"}).status_code == 401


def test_wrong_signing_key():
    token = make_token(key=OTHER_KEY)
    assert get_me({"Authorization": f"Bearer {token}"}).status_code == 401


def test_error_does_not_echo_token():
    token = make_token(aud="anon")
    response = get_me({"Authorization": f"Bearer {token}"})
    assert token not in response.text


def test_health_stays_public():
    assert TestClient(app).get("/health").status_code == 200
