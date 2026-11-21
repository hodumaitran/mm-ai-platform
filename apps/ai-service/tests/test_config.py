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
