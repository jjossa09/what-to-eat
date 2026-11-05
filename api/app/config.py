from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class MissingSettingError(RuntimeError):
    pass


class Settings(BaseSettings):
    # Names match api/.env.example. All optional so the app starts without keys;
    # code that needs one calls require(), which fails with the variable name only.
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    REASONS_SIGNING_SECRET: SecretStr | None = None
    META_API_KEY: SecretStr | None = None
    GEOAPIFY_API_KEY: SecretStr | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_ANON_KEY: SecretStr | None = None
    SUPABASE_SERVICE_ROLE_KEY: SecretStr | None = None
    PLACES_RADIUS_M: int = 5000  # FR-R3 cold-start radius
    PLACES_TIMEOUT_S: float = 4.0  # Map and named lookup; recommendations have a scoped cap
    RECOMMENDATION_PLACES_TIMEOUT_S: float = Field(default=8.0, gt=0, le=8)
    SUPABASE_TIMEOUT_S: float = 2.0  # history reads run alongside the places search
    MUSE_TIMEOUT_S: float = 12.0  # independent reasons enhancement
    MUSE_PARSE_TIMEOUT_S: float = Field(default=14.0, gt=0, le=14)
    MUSE_PARSE_MAX_TOKENS: int = Field(default=1400, ge=1, le=1400)
    MUSE_PARSE_DEADLINE_S: float = Field(default=17.0, gt=0, le=17)
    MUSE_TAKEAWAY_TIMEOUT_S: float = 8.0
    MUSE_TAKEAWAY_DAILY_CAP: int = 10  # under the shared cap, per UTC day and instance
    MUSE_DAILY_CAP: int = 200  # Muse calls per UTC day, per instance (see app/muse.py)

    def require(self, name: str) -> str:
        value = getattr(self, name)
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if not value:
            raise MissingSettingError(f"{name} is not set (add it to api/.env)")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
