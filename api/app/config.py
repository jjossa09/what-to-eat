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
