import asyncio
import json
from collections.abc import AsyncIterator, Callable
from typing import Any, cast

import httpx
import pytest

from mm_ai_service.domain.errors import (
    InvalidProviderResponseError,
    ModelUnavailableError,
    ProviderConnectionError,
    ProviderOverloadError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    ContentDelta,
    FinishReason,
    GenerationOptions,
    MessageRole,
    StreamEvent,
    StreamStarted,
    ThinkingConfiguration,
    ThinkingMode,
    TokenUsage,
)
from mm_ai_service.infrastructure.ollama import OllamaProvider

MODEL = "qwen3.5:35b"
Handler = Callable[[httpx.Request], httpx.Response]


def _provider(
    handler: httpx.AsyncBaseTransport | Handler,
    *,
    clock: Callable[[], float] | None = None,
) -> OllamaProvider:
    transport = (
        handler if isinstance(handler, httpx.AsyncBaseTransport) else httpx.MockTransport(handler)
    )
    return OllamaProvider(
        base_url="http://127.0.0.1:11434",
        model=MODEL,
        context_window=4096,
        connect_timeout_seconds=0.1,
        read_timeout_seconds=0.1,
        readiness_timeout_seconds=0.1,
        readiness_cache_seconds=10,
        transport=transport,
        clock=clock or (lambda: 0.0),
    )


def _request(thinking: ThinkingMode = ThinkingMode.DEFAULT) -> CompletionRequest:
    return CompletionRequest(
        MODEL,
        (
            ChatMessage(MessageRole.SYSTEM, "Be concise."),
            ChatMessage(MessageRole.USER, "Hello"),
        ),
        GenerationOptions(
            temperature=0.2,
            max_output_tokens=16,
            context_window=4096,
            stop_sequences=("END",),
        ),
        ThinkingConfiguration(thinking),
    )


def _api_response(
    request: httpx.Request,
    *,
    model_present: bool = True,
    thinking: bool = True,
) -> httpx.Response | None:
    if request.url.path == "/api/version":
        return httpx.Response(200, json={"version": "0.40.16"})
    if request.url.path == "/api/tags":
        models = [{"name": MODEL, "model": MODEL}] if model_present else []
        return httpx.Response(200, json={"models": models})
    if request.url.path == "/api/show":
        capabilities = ["completion", "thinking"] if thinking else ["completion"]
        return httpx.Response(
            200,
            json={
                "capabilities": capabilities,
                "thinking": {"values": [False, True], "default": True},
                "model_info": {"qwen.context_length": 32768},
            },
        )
    return None


def _chat_response(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": MODEL,
        "message": {"role": "assistant", "content": "Hello back"},
        "done": True,
        "done_reason": "stop",
        "prompt_eval_count": 7,
        "eval_count": 3,
    }
    payload.update(overrides)
    return payload


def test_completion_maps_request_response_thinking_and_usage() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        setup = _api_response(request)
        if setup is not None:
            return setup
        assert request.url.path == "/api/chat"
        seen.append(cast(dict[str, Any], json.loads(request.content)))
        return httpx.Response(200, json=_chat_response())

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        response = await provider.complete(_request(ThinkingMode.DISABLED))
        assert response.message.content == "Hello back"
        assert response.finish_reason is FinishReason.STOP
        assert response.usage == TokenUsage(7, 3, 10)
        await provider.stop()

    asyncio.run(exercise())
    assert seen == [
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": "Be concise."},
                {"role": "user", "content": "Hello"},
            ],
            "stream": False,
            "options": {
                "temperature": 0.2,
                "num_predict": 16,
                "num_ctx": 4096,
                "stop": ["END"],
            },
            "think": False,
        }
    ]


def test_thinking_default_is_omitted_and_enabled_maps_to_true() -> None:
    payloads: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        setup = _api_response(request)
        if setup is not None:
            return setup
        payloads.append(cast(dict[str, Any], json.loads(request.content)))
        return httpx.Response(200, json=_chat_response())

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        await provider.complete(_request())
        await provider.complete(_request(ThinkingMode.ENABLED))
        assert provider.capabilities.thinking is True
        await provider.stop()

    asyncio.run(exercise())
    assert "think" not in payloads[0]
    assert payloads[1]["think"] is True


@pytest.mark.parametrize(
    "payload",
    [
        {"model": MODEL, "done": True},
        _chat_response(model="other"),
        _chat_response(done=False),
        _chat_response(message={"role": "user", "content": "wrong"}),
        _chat_response(prompt_eval_count=-1),
    ],
)
def test_invalid_provider_payloads_are_rejected(payload: dict[str, Any]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _api_response(request) or httpx.Response(200, json=payload)

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        with pytest.raises(InvalidProviderResponseError):
            await provider.complete(_request())
        await provider.stop()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (404, ModelUnavailableError),
        (429, ProviderOverloadError),
        (500, ProviderUnavailableError),
        (504, ProviderTimeoutError),
    ],
)
def test_http_errors_are_normalized(status: int, error_type: type[Exception]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _api_response(request) or httpx.Response(status, json={"error": "private detail"})

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        with pytest.raises(error_type):
            await provider.complete(_request())
        await provider.stop()

    asyncio.run(exercise())


@pytest.mark.parametrize("failure", ["connection", "timeout"])
def test_transport_failures_are_normalized(failure: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        setup = _api_response(request)
        if setup is not None:
            return setup
        if failure == "connection":
            raise httpx.ConnectError("private endpoint detail", request=request)
        raise httpx.ReadTimeout("private timeout detail", request=request)

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        expected = ProviderConnectionError if failure == "connection" else ProviderTimeoutError
        with pytest.raises(expected):
            await provider.complete(_request())
        await provider.stop()

    asyncio.run(exercise())


def test_cancellation_propagates() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        setup = _api_response(request)
        if setup is not None:
            return setup
        await asyncio.Event().wait()
        return httpx.Response(200, json=_chat_response())

    async def exercise() -> None:
        provider = _provider(httpx.MockTransport(handler))
        await provider.start()
        task = asyncio.create_task(provider.complete(_request()))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await provider.stop()

    asyncio.run(exercise())


def test_readiness_checks_version_model_details_and_uses_cache() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        response = _api_response(request)
        assert response is not None
        return response

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        first = await provider.check_readiness()
        second = await provider.check_readiness()
        assert first == second
        assert first.provider_available is True
        assert first.model_available is True
        assert first.inference_available is True
        assert provider.capabilities.streaming is True
        assert provider.capabilities.thinking is True
        assert provider.capabilities.tool_calling is False
        assert provider.capabilities.structured_output is False
        assert provider.capabilities.max_context_tokens == 4096
        await provider.stop()

    asyncio.run(exercise())
    assert calls == ["/api/version", "/api/tags", "/api/show"]


def test_readiness_distinguishes_missing_model_from_unavailable_provider() -> None:
    def missing_handler(request: httpx.Request) -> httpx.Response:
        response = _api_response(request, model_present=False)
        assert response is not None
        return response

    def unavailable_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unavailable", request=request)

    async def exercise() -> None:
        missing = _provider(missing_handler)
        unavailable = _provider(unavailable_handler)
        await missing.start()
        await unavailable.start()
        missing_state = await missing.check_readiness()
        unavailable_state = await unavailable.check_readiness()
        assert missing_state.provider_available is True
        assert missing_state.model_available is False
        assert unavailable_state.provider_available is False
        await missing.stop()
        await unavailable.stop()

    asyncio.run(exercise())


def test_streaming_maps_events_and_drops_reasoning_trace() -> None:
    chunks = "\n".join(
        [
            json.dumps(
                {
                    "model": MODEL,
                    "message": {"role": "assistant", "content": "", "thinking": "secret"},
                    "done": False,
                }
            ),
            json.dumps(
                {
                    "model": MODEL,
                    "message": {"role": "assistant", "content": "Hi"},
                    "done": False,
                }
            ),
            json.dumps(
                {
                    "model": MODEL,
                    "message": {"role": "assistant", "content": ""},
                    "done": True,
                    "done_reason": "length",
                    "prompt_eval_count": 2,
                    "eval_count": 1,
                }
            ),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return _api_response(request) or httpx.Response(200, content=chunks)

    async def exercise() -> list[StreamEvent]:
        provider = _provider(handler)
        await provider.start()
        events = [event async for event in provider.stream(_request(ThinkingMode.ENABLED))]
        await provider.stop()
        return events

    events = asyncio.run(exercise())
    assert events == [
        StreamStarted(MODEL),
        ContentDelta("Hi"),
        CompletionFinished(FinishReason.LENGTH, TokenUsage(2, 1, 3)),
    ]
    assert "secret" not in repr(events)


def test_stream_cancellation_closes_response_and_propagates() -> None:
    class BlockingStream(httpx.AsyncByteStream):
        def __init__(self) -> None:
            self.entered = asyncio.Event()
            self.closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield (
                json.dumps(
                    {
                        "model": MODEL,
                        "message": {"role": "assistant", "content": "first"},
                        "done": False,
                    }
                ).encode()
                + b"\n"
            )
            self.entered.set()
            await asyncio.Event().wait()

        async def aclose(self) -> None:
            self.closed = True

    stream = BlockingStream()

    def handler(request: httpx.Request) -> httpx.Response:
        setup = _api_response(request)
        return setup or httpx.Response(200, stream=stream)

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()

        async def consume() -> None:
            async for _event in provider.stream(_request()):
                pass

        task = asyncio.create_task(consume())
        await stream.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stream.closed is True
        await provider.stop()

    asyncio.run(exercise())


def test_stop_closes_owned_client_and_prevents_further_requests() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _api_response(request) or httpx.Response(200, json=_chat_response())

    async def exercise() -> None:
        provider = _provider(handler)
        await provider.start()
        await provider.stop()
        with pytest.raises(ProviderUnavailableError):
            await provider.complete(_request())

    asyncio.run(exercise())
