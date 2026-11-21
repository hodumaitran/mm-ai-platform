import io
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.infrastructure.logging import build_service_logger
from mm_ai_service.main import create_app


@dataclass
class RecordingResource:
    name: str
    events: list[str]
    fail_start: bool = False
    fail_stop: bool = False

    async def start(self) -> None:
        self.events.append(f"start:{self.name}")
        if self.fail_start:
            raise RuntimeError(f"start failed: {self.name}")

    async def stop(self) -> None:
        self.events.append(f"stop:{self.name}")
        if self.fail_stop:
            raise RuntimeError(f"stop failed: {self.name}")


def test_factory_creates_independent_instances() -> None:
    first = create_app(Settings(env="development", _env_file=None))
    second = create_app(Settings(env="test", _env_file=None))
    assert first is not second
    with TestClient(first) as first_client, TestClient(second) as second_client:
        assert first_client.get("/ready").json()["environment"] == "development"
        assert second_client.get("/ready").json()["environment"] == "test"


def test_factory_captures_resource_ownership_at_composition_time() -> None:
    events: list[str] = []
    resources = [RecordingResource("owned", events)]
    app = create_app(Settings(env="test", _env_file=None), resources=resources)
    resources.append(RecordingResource("late", events))
    with TestClient(app):
        pass
    assert events == ["start:owned", "stop:owned"]


def test_lifecycle_starts_in_order_and_stops_in_reverse_order() -> None:
    events: list[str] = []
    resources = [RecordingResource("one", events), RecordingResource("two", events)]
    with TestClient(create_app(Settings(env="test", _env_file=None), resources=resources)):
        assert events == ["start:one", "start:two"]
    assert events == ["start:one", "start:two", "stop:two", "stop:one"]


def test_startup_failure_rolls_back_only_started_resources() -> None:
    events: list[str] = []
    resources = [
        RecordingResource("one", events),
        RecordingResource("two", events, fail_start=True),
    ]
    with (
        pytest.raises(RuntimeError, match="start failed: two"),
        TestClient(create_app(Settings(env="test", _env_file=None), resources=resources)),
    ):
        pass
    assert events == ["start:one", "start:two", "stop:one"]


def test_shutdown_attempts_all_cleanup_and_reports_failure() -> None:
    events: list[str] = []
    stream = io.StringIO()
    resources = [
        RecordingResource("one", events),
        RecordingResource("two", events, fail_stop=True),
    ]
    with (
        pytest.raises(BaseExceptionGroup, match="Resource shutdown failed"),
        TestClient(
            create_app(
                Settings(env="test", _env_file=None),
                resources=resources,
                logger=build_service_logger("INFO", stream),
            )
        ),
    ):
        pass
    assert events == ["start:one", "start:two", "stop:two", "stop:one"]
    assert "resource.stop_failed" in stream.getvalue()
