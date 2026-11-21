from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.main import create_app


def test_health_reports_process_liveness() -> None:
    with TestClient(create_app(Settings(env="test", _env_file=None))) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"service": "ai-service", "status": "ok"}


def test_ready_does_not_claim_inference_readiness() -> None:
    with TestClient(create_app(Settings(env="test", _env_file=None))) as client:
        response = client.get("/ready")
    assert response.status_code == 200
    assert response.json() == {
        "service": "ai-service",
        "status": "ready",
        "capabilities": {
            "configuration": True,
            "ollama": False,
            "inference": False,
        },
        "environment": "test",
    }
