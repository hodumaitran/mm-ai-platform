import os
import subprocess
import sys

import pytest
from pydantic import ValidationError

from mm_ai_service.config import Settings


def test_settings_use_loopback_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.host == "127.0.0.1"
    assert settings.port == 8000


@pytest.mark.parametrize("port", [0, 65536])
def test_settings_reject_invalid_ports(port: int) -> None:
    with pytest.raises(ValidationError):
        Settings(port=port, _env_file=None)


def test_settings_reject_empty_hosts() -> None:
    with pytest.raises(ValidationError):
        Settings(host="", _env_file=None)


def test_settings_load_fails_fast_for_invalid_environment() -> None:
    environment = os.environ.copy()
    environment["AI_SERVICE_PORT"] = "0"
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from mm_ai_service.config import load_settings; load_settings()",
        ],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
    )
    assert result.returncode != 0
    assert "validation error" in result.stderr.lower()


def test_settings_are_immutable_and_have_safe_representation() -> None:
    settings = Settings(env="test", _env_file=None)
    assert "test" in repr(settings)
    with pytest.raises(ValidationError):
        settings.port = 9000  # type: ignore[misc]


def test_gateway_settings_have_safe_local_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.llm_provider is None
    assert settings.llm_max_concurrency == 1
    assert settings.llm_request_timeout_seconds == 120
    assert settings.llm_default_temperature == 0.2
    assert settings.llm_default_context_window == 4096
    assert settings.ollama_base_url == "http://127.0.0.1:11434"
    assert settings.ollama_model == "qwen3.5:35b"
    assert settings.ollama_network_policy == "loopback"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("llm_provider", "unsafe provider"),
        ("llm_max_concurrency", 0),
        ("llm_request_timeout_seconds", 0),
        ("llm_default_temperature", 2.1),
        ("llm_default_max_output_tokens", 0),
        ("llm_default_context_window", 0),
        ("ollama_base_url", "https://ollama.com"),
        ("ollama_base_url", "http://user:password@127.0.0.1:11434"),
        ("ollama_base_url", "http://192.168.1.20:11434"),
        ("ollama_model", "invalid model"),
        ("ollama_connect_timeout_seconds", 0),
        ("ollama_read_timeout_seconds", 0),
        ("ollama_readiness_timeout_seconds", 0),
        ("ollama_readiness_cache_seconds", -1),
    ],
)
def test_gateway_settings_reject_invalid_values(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        Settings(**{field: value}, _env_file=None)  # type: ignore[arg-type]


def test_gateway_settings_reject_output_limit_larger_than_context() -> None:
    with pytest.raises(ValidationError):
        Settings(
            llm_default_max_output_tokens=4097,
            llm_default_context_window=4096,
            _env_file=None,
        )


def test_private_ollama_policy_requires_production_and_private_ip() -> None:
    with pytest.raises(ValidationError):
        Settings(
            env="development",
            ollama_network_policy="private",
            ollama_base_url="http://192.168.1.20:11434",
            _env_file=None,
        )
    settings = Settings(
        env="production",
        ollama_network_policy="private",
        ollama_base_url="http://192.168.1.20:11434",
        _env_file=None,
    )
    assert settings.ollama_network_policy == "private"
