from fastapi import FastAPI
from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.domain.errors import (
    CapabilityUnavailableError,
    ConfigurationError,
    InvalidRequestError,
)
from mm_ai_service.main import create_app


def _app_with_failure(error: Exception) -> FastAPI:
    app = create_app(Settings(env="test", _env_file=None))

    @app.get("/failure")
    async def failure() -> None:
        raise error

    return app


def test_unhandled_error_contract_does_not_disclose_exception_details() -> None:
    with TestClient(
        _app_with_failure(RuntimeError("private detail")), raise_server_exceptions=False
    ) as client:
        response = client.get("/failure", headers={"X-Request-ID": "error-test"})
    assert response.status_code == 500
    assert response.json() == {
        "error": {
            "code": "INTERNAL_ERROR",
            "message": "An unexpected error occurred.",
            "request_id": "error-test",
        }
    }
    assert response.headers["X-Request-ID"] == "error-test"
    assert "private detail" not in response.text


def test_domain_errors_have_stable_http_mappings() -> None:
    cases = [
        (InvalidRequestError(), 400, "INVALID_REQUEST"),
        (ConfigurationError(), 500, "CONFIGURATION_ERROR"),
        (CapabilityUnavailableError(), 503, "CAPABILITY_UNAVAILABLE"),
    ]
    for error, status_code, code in cases:
        with TestClient(_app_with_failure(error), raise_server_exceptions=False) as client:
            response = client.get("/failure")
        assert response.status_code == status_code
        assert response.json()["error"]["code"] == code
        assert response.json()["error"]["request_id"] == response.headers["X-Request-ID"]


def test_fastapi_validation_uses_safe_invalid_request_contract() -> None:
    app = create_app(Settings(env="test", _env_file=None))

    @app.get("/validation/{value}")
    async def validation_probe(value: int) -> dict[str, int]:
        return {"value": value}

    with TestClient(app) as client:
        response = client.get("/validation/not-an-integer")
    assert response.status_code == 422
    assert response.json()["error"] == {
        "code": "INVALID_REQUEST",
        "message": "The request is invalid.",
        "request_id": response.headers["X-Request-ID"],
    }
