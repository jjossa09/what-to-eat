from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class MissingSettingError(RuntimeError):
    pass


class Settings(BaseSettings):
    # Names match api/.env.example. All optional so the app starts without keys;
    # code that needs one calls require(), which fails with the variable name only.
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore")

    META_API_KEY: SecretStr | None = None
    GEOAPIFY_API_KEY: SecretStr | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_ANON_KEY: SecretStr | None = None
    SUPABASE_SERVICE_ROLE_KEY: SecretStr | None = None
    PLACES_RADIUS_M: int = 5000  # FR-R3 cold-start radius
    PLACES_TIMEOUT_S: float = 4.0  # leaves room for Muse in the ~8 s first round (NFR4)
    SUPABASE_TIMEOUT_S: float = 2.0  # history reads run alongside the places search
    MUSE_TIMEOUT_S: float = 3.5  # after places (up to 4 s), keeps the round under ~8 s
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
