import asyncio
from collections.abc import AsyncIterator

from fastapi.testclient import TestClient
from starlette.types import Message

from mm_ai_service.config import Settings
from mm_ai_service.domain.errors import ProviderConnectionError, RequestCancelledError
from mm_ai_service.domain.llm import (
    CompletionFinished,
    CompletionRequest,
    ContentDelta,
    FinishReason,
    ModelCapabilities,
    StreamEvent,
    StreamStarted,
    TokenUsage,
    UsageUpdate,
)
from mm_ai_service.main import create_app
from mm_ai_service.presentation.routes import _await_or_disconnect
from tests.fakes import FakeProvider, response_for


def _payload(content: str = "Xin chào") -> dict[str, object]:
    return {
        "version": "1",
        "messages": [{"role": "user", "content": content}],
        "generation": {"temperature": 0.2, "max_output_tokens": 64},
        "thinking": {"mode": "disabled"},
    }


def _app(
    stream_handler: object | None = None,
) -> tuple[TestClient, list[CompletionRequest]]:
    seen: list[CompletionRequest] = []

    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        seen.append(request)
        return response_for(request, content="Chào bạn", usage=TokenUsage(7, 3, 10))

    async def normal_stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        seen.append(request)
        yield StreamStarted(request.model_identifier)
        yield ContentDelta("Xin ")
        yield ContentDelta("chào")
        yield UsageUpdate(TokenUsage(6, 2, 8))
        yield CompletionFinished(FinishReason.STOP, TokenUsage(6, 2, 8))

    provider = FakeProvider(
        complete,
        stream_handler if stream_handler is not None else normal_stream,  # type: ignore[arg-type]
        capabilities=ModelCapabilities(
            streaming=True,
            thinking=True,
            max_context_tokens=4096,
        ),
    )
    settings = Settings(env="test", llm_provider="fake", _env_file=None)
    return TestClient(create_app(settings, providers=(provider,))), seen


def test_chat_completion_maps_public_contract_and_correlation() -> None:
    client, seen = _app()
    with client:
        response = client.post(
            "/v1/chat/completions",
            json=_payload(),
            headers={"X-Request-ID": "chat-test"},
        )
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "chat-test"
    assert response.json() == {
        "version": "1",
        "request_id": "chat-test",
        "model": "qwen3.5:35b",
        "message": {"role": "assistant", "content": "Chào bạn"},
        "finish_reason": "stop",
        "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10},
    }
    assert seen[0].options.max_output_tokens == 64
    assert seen[0].options.context_window == 4096


def test_chat_stream_has_valid_utf8_sse_order_and_one_terminal_event() -> None:
    client, _seen = _app()
    with client:
        response = client.post(
            "/v1/chat/completions/stream",
            json=_payload(),
            headers={"X-Request-ID": "stream-test"},
        )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache, no-store, must-revalidate"
    text = response.content.decode("utf-8")
    assert "Xin chào" not in text  # deltas remain independently framed
    assert '"content":"Xin "' in text
    assert '"content":"chào"' in text
    names = [
        line.removeprefix("event: ") for line in text.splitlines() if line.startswith("event: ")
    ]
    assert names == [
        "stream.started",
        "content.delta",
        "content.delta",
        "usage.updated",
        "stream.completed",
    ]
    assert names.count("stream.completed") == 1
    assert "reasoning" not in text


def test_stream_failure_after_headers_becomes_one_safe_terminal_error() -> None:
    async def failing_stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield StreamStarted(request.model_identifier)
        raise ProviderConnectionError()

    client, _seen = _app(failing_stream)
    with client:
        response = client.post("/v1/chat/completions/stream", json=_payload())
    assert response.status_code == 200
    assert response.text.count("event: stream.error") == 1
    assert "PROVIDER_CONNECTION_FAILURE" in response.text
    assert "stream.completed" not in response.text


def test_stream_failure_before_headers_uses_safe_http_error_contract() -> None:
    async def failing_stream(_request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        raise ProviderConnectionError()
        if False:
            yield

    client, _seen = _app(failing_stream)
    with client:
        response = client.post(
            "/v1/chat/completions/stream",
            json=_payload(),
            headers={"X-Request-ID": "pre-header-failure"},
        )
    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "error": {
            "code": "PROVIDER_CONNECTION_FAILURE",
            "message": "The provider connection failed.",
            "request_id": "pre-header-failure",
        }
    }


def test_incomplete_stream_becomes_safe_terminal_error() -> None:
    async def incomplete_stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield StreamStarted(request.model_identifier)
        yield ContentDelta("partial")

    client, _seen = _app(incomplete_stream)
    with client:
        response = client.post("/v1/chat/completions/stream", json=_payload())
    assert response.text.count("event: stream.error") == 1
    assert "INVALID_PROVIDER_RESPONSE" in response.text
    assert response.text.index("content.delta") < response.text.index("stream.error")


def test_invalid_json_schema_roles_and_unauthorized_model_are_rejected() -> None:
    client, _seen = _app()
    cases: list[tuple[bytes | None, dict[str, object] | None]] = [
        (b"{", None),
        (None, {**_payload(), "unknown": True}),
        (None, {**_payload(), "model": "unauthorized:model"}),
        (None, {**_payload(), "messages": [{"role": "system", "content": "override"}]}),
        (None, {**_payload(), "messages": [{"role": "assistant", "content": "wrong"}]}),
    ]
    with client:
        for raw, json_body in cases:
            response = (
                client.post(
                    "/v1/chat/completions",
                    content=raw,
                    headers={"Content-Type": "application/json"},
                )
                if raw is not None
                else client.post("/v1/chat/completions", json=json_body)
            )
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "INVALID_REQUEST"


def test_message_count_text_and_generation_budgets_are_rejected() -> None:
    client, _seen = _app()
    too_many: list[dict[str, str]] = []
    for index in range(17):
        too_many.append({"role": "user" if index % 2 == 0 else "assistant", "content": str(index)})
    cases = [
        {**_payload(), "messages": too_many},
        _payload("x" * 2049),
        {**_payload(), "generation": {"temperature": 0.2, "max_output_tokens": 1025}},
        _payload("x" * 3073),
    ]
    with client:
        for body in cases:
            response = client.post("/v1/chat/completions", json=body)
            assert response.status_code == 400


def test_body_size_and_media_type_limits_are_explicit() -> None:
    settings = Settings(
        env="test",
        llm_provider="fake",
        chat_max_body_bytes=1024,
        _env_file=None,
    )

    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(_request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if False:
            yield

    limited = TestClient(
        create_app(
            settings,
            providers=(
                FakeProvider(complete, stream, capabilities=ModelCapabilities(streaming=True)),
            ),
        )
    )
    with limited:
        oversized = limited.post(
            "/v1/chat/completions",
            content=b"x" * 1025,
            headers={"Content-Type": "application/json"},
        )
        wrong_type = limited.post(
            "/v1/chat/completions",
            content=b"{}",
            headers={"Content-Type": "text/plain"},
        )
    assert oversized.status_code == 413
    assert oversized.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
    assert wrong_type.status_code == 415
    assert wrong_type.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_thinking_mode_is_explicitly_mapped_without_reasoning_output() -> None:
    client, seen = _app()
    body = _payload()
    body["thinking"] = {"mode": "enabled"}
    with client:
        response = client.post("/v1/chat/completions", json=body)
    assert response.status_code == 200
    assert seen[0].thinking.mode.value == "enabled"
    assert "thinking" not in response.text
    assert "reasoning" not in response.text


def test_disconnect_cancels_pre_header_operation_and_runs_cleanup() -> None:
    async def exercise() -> bool:
        messages: asyncio.Queue[Message] = asyncio.Queue()
        cancelled = False

        async def operation() -> None:
            nonlocal cancelled
            try:
                await asyncio.Event().wait()
            finally:
                cancelled = True

        task = asyncio.create_task(_await_or_disconnect(operation(), messages.get))
        await messages.put({"type": "http.disconnect"})
        try:
            await task
        except RequestCancelledError:
            pass
        else:
            raise AssertionError("disconnect must cancel the operation")
        return cancelled

    assert asyncio.run(exercise()) is True
