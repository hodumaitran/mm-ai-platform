import io
import json

from fastapi import Request
from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.infrastructure.logging import build_service_logger
from mm_ai_service.main import create_app


def test_request_logging_is_structured_and_excludes_sensitive_content() -> None:
    stream = io.StringIO()
    app = create_app(
        Settings(env="test", _env_file=None),
        logger=build_service_logger("INFO", stream),
    )

    @app.post("/log-probe")
    async def log_probe(request: Request) -> dict[str, bool]:
        await request.body()
        return {"ok": True}

    with TestClient(app) as client:
        response = client.post(
            "/log-probe?token=query-secret",
            headers={
                "Authorization": "Bearer header-secret",
                "X-Request-ID": "privacy-test",
            },
            json={"prompt": "body-secret"},
        )
    assert response.status_code == 200

    output = stream.getvalue()
    assert "query-secret" not in output
    assert "header-secret" not in output
    assert "body-secret" not in output
    request_event = next(
        json.loads(line)
        for line in output.splitlines()
        if json.loads(line)["event"] == "http.request_completed"
    )
    assert request_event["service"] == "ai-service"
    assert request_event["severity"] == "INFO"
    assert request_event["request_id"] == "privacy-test"
    assert request_event["path"] == "/log-probe"
    assert "timestamp" in request_event


def test_logging_drops_metadata_outside_the_allowlist() -> None:
    stream = io.StringIO()
    logger = build_service_logger("INFO", stream)
    logger.event(
        20,
        "privacy.probe",
        metadata={"path": "/safe", "prompt": "never-log-this"},
    )
    assert json.loads(stream.getvalue())["path"] == "/safe"
    assert "never-log-this" not in stream.getvalue()
