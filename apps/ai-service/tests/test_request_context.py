import asyncio
import re

import httpx
from fastapi import Request
from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.main import create_app
from mm_ai_service.presentation.request_context import current_request_id, resolve_request_id


def test_request_id_is_generated_and_unsafe_values_are_replaced() -> None:
    app = create_app(Settings(env="test", _env_file=None))
    with TestClient(app) as client:
        generated = client.get("/health").headers["X-Request-ID"]
        replaced = client.get(
            "/health", headers={"X-Request-ID": "unsafe value/with spaces"}
        ).headers["X-Request-ID"]
        preserved = client.get("/health", headers={"X-Request-ID": "safe.ID-_123"}).headers[
            "X-Request-ID"
        ]
    assert re.fullmatch(r"[0-9a-f]{32}", generated)
    assert re.fullmatch(r"[0-9a-f]{32}", replaced)
    assert preserved == "safe.ID-_123"


def test_request_id_replaces_non_ascii_and_overlong_values() -> None:
    non_ascii = "safe\N{LATIN SMALL LETTER E WITH ACUTE}"
    assert resolve_request_id(non_ascii) != non_ascii
    assert resolve_request_id("a" * 65) != "a" * 65


def test_request_context_is_isolated_across_concurrent_requests() -> None:
    app = create_app(Settings(env="test", _env_file=None))

    @app.get("/context-probe")
    async def context_probe(_request: Request) -> dict[str, str | None]:
        await asyncio.sleep(0.01)
        return {"request_id": current_request_id()}

    async def exercise() -> tuple[httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await asyncio.gather(
                client.get("/context-probe", headers={"X-Request-ID": "request-one"}),
                client.get("/context-probe", headers={"X-Request-ID": "request-two"}),
            )

    responses = asyncio.run(exercise())
    assert [response.json()["request_id"] for response in responses] == [
        "request-one",
        "request-two",
    ]
    assert current_request_id() is None
