from ipaddress import ip_address
from typing import Literal, Self
from urllib.parse import urlsplit

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
    llm_max_pending_requests: int = Field(default=1, ge=0, le=64)
    llm_admission_timeout_seconds: float = Field(default=30.0, gt=0, le=3600)
    llm_first_token_timeout_seconds: float = Field(default=240.0, gt=0, le=3600)
    llm_stream_inactivity_timeout_seconds: float = Field(default=30.0, gt=0, le=3600)
    llm_request_timeout_seconds: float = Field(default=300.0, gt=0, le=3600)
    llm_default_temperature: float = Field(default=0.2, ge=0, le=2)
    llm_default_max_output_tokens: int = Field(default=1024, ge=1)
    llm_default_context_window: int = Field(default=4096, ge=1)
    chat_max_body_bytes: int = Field(default=65536, ge=1024, le=1048576)
    chat_max_messages: int = Field(default=16, ge=1, le=128)
    chat_max_message_characters: int = Field(default=2048, ge=1, le=65536)
    chat_max_input_characters: int = Field(default=3072, ge=1, le=262144)
    chat_max_output_tokens: int = Field(default=1024, ge=1)
    # Document processing (MVP-03). These are configurable safety limits, not verified capacity.
    document_max_bytes: int = Field(default=50 * 1024 * 1024, ge=1024, le=1024**3)
    document_max_pdf_pages: int = Field(default=5000, ge=1, le=100_000)
    document_max_concurrency: int = Field(default=1, ge=1, le=8)
    document_process_timeout_seconds: float = Field(default=600.0, gt=0, le=7200)
    document_max_extracted_chars: int = Field(default=40_000_000, ge=1000)
    document_max_chunks: int = Field(default=100_000, ge=1)
    document_chunk_target_tokens: int = Field(default=512, ge=32, le=8192)
    document_chunk_overlap_tokens: int = Field(default=64, ge=0, le=2048)
    document_chunk_max_tokens: int = Field(default=768, ge=64, le=16384)
    document_docx_max_entries: int = Field(default=5000, ge=1)
    document_docx_max_uncompressed_bytes: int = Field(default=300 * 1024 * 1024, ge=1024)
    document_docx_max_compression_ratio: int = Field(default=100, ge=1)
    document_worker_memory_limit_bytes: int = Field(default=2 * 1024**3, ge=64 * 1024**2)
    document_temp_dir: str | None = None

    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = Field(
        default="qwen3.5:35b",
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
    )
    ollama_network_policy: Literal["loopback", "private"] = "loopback"
    ollama_connect_timeout_seconds: float = Field(default=5.0, gt=0, le=60)
    ollama_read_timeout_seconds: float = Field(default=300.0, gt=0, le=3600)
    ollama_readiness_timeout_seconds: float = Field(default=3.0, gt=0, le=30)
    ollama_readiness_cache_seconds: float = Field(default=10.0, ge=0, le=300)

    @model_validator(mode="after")
    def validate_generation_defaults(self) -> Self:
        host_is_loopback = self.host == "localhost"
        if not host_is_loopback:
            try:
                host_is_loopback = ip_address(self.host).is_loopback
            except ValueError as error:
                raise ValueError("AI service host must be a loopback address") from error
        if not host_is_loopback:
            raise ValueError("AI service host must be a loopback address")
        if self.llm_default_max_output_tokens > self.llm_default_context_window:
            raise ValueError("LLM maximum output tokens cannot exceed the context window")
        if self.chat_max_output_tokens > self.llm_default_context_window:
            raise ValueError("Chat maximum output tokens cannot exceed the context window")
        if self.chat_max_input_characters + self.chat_max_output_tokens > (
            self.llm_default_context_window
        ):
            raise ValueError("Chat input and output budgets cannot exceed the context window")
        if self.chat_max_message_characters > self.chat_max_input_characters:
            raise ValueError("Chat message limit cannot exceed the aggregate input limit")
        if not (
            self.document_chunk_overlap_tokens
            < self.document_chunk_target_tokens
            <= self.document_chunk_max_tokens
        ):
            raise ValueError("Document chunk sizes must satisfy overlap < target <= maximum")
        parsed = urlsplit(self.ollama_base_url)
        if (
            parsed.scheme != "http"
            or parsed.hostname is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/")
        ):
            raise ValueError("Ollama base URL must be an HTTP origin without credentials")
        try:
            parsed_port = parsed.port
        except ValueError as error:
            raise ValueError("Ollama base URL has an invalid port") from error
        if parsed_port is None:
            raise ValueError("Ollama base URL must include an explicit port")
        host = parsed.hostname
        is_loopback = host == "localhost"
        is_private = False
        if not is_loopback:
            try:
                address = ip_address(host)
            except ValueError as error:
                raise ValueError(
                    "Ollama host must be localhost or an explicit IP address"
                ) from error
            is_loopback = address.is_loopback
            is_private = address.is_private
        if self.ollama_network_policy == "loopback" and not is_loopback:
            raise ValueError("Loopback Ollama policy requires a loopback host")
        if self.ollama_network_policy == "private" and (
            self.env != "production" or not (is_loopback or is_private)
        ):
            raise ValueError("Private Ollama policy requires production and a private IP")
        return self


def load_settings() -> Settings:
    """Load a fresh settings instance using Pydantic's documented source precedence."""
    return Settings()
