from typing import Literal, Self

from pydantic import Field, model_validator
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
    llm_provider: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9._-]{0,63}$")
    llm_max_concurrency: int = Field(default=1, ge=1, le=64)
    llm_request_timeout_seconds: float = Field(default=120.0, gt=0, le=3600)
    llm_default_temperature: float = Field(default=0.2, ge=0, le=2)
    llm_default_max_output_tokens: int = Field(default=1024, ge=1)
    llm_default_context_window: int = Field(default=4096, ge=1)

    @model_validator(mode="after")
    def validate_generation_defaults(self) -> Self:
        if self.llm_default_max_output_tokens > self.llm_default_context_window:
            raise ValueError("LLM maximum output tokens cannot exceed the context window")
        return self


def load_settings() -> Settings:
    """Load a fresh settings instance using Pydantic's documented source precedence."""
    return Settings()
