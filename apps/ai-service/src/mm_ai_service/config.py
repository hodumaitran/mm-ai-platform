from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated runtime settings owned by the AI service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="AI_SERVICE_",
        extra="forbid",
        frozen=True,
    )

    env: Literal["development", "test", "production"] = "development"
    host: str = Field(default="127.0.0.1", min_length=1)
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"


def load_settings() -> Settings:
    """Load a fresh settings instance using Pydantic's documented source precedence."""
    return Settings()
