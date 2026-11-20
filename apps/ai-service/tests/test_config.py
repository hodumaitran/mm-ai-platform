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


def test_application_import_fails_fast_for_invalid_environment() -> None:
    environment = os.environ.copy()
    environment["AI_SERVICE_PORT"] = "0"
    result = subprocess.run(
        [sys.executable, "-c", "import mm_ai_service.main"],
        capture_output=True,
        check=False,
        env=environment,
        text=True,
    )
    assert result.returncode != 0
    assert "validation error" in result.stderr.lower()
