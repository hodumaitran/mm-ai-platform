import asyncio
from collections.abc import AsyncIterator

import pytest

from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    FirstTokenTimeoutError,
    InvalidProviderResponseError,
    StreamInactivityTimeoutError,
    UnsupportedCapabilityError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    ContentDelta,
    FinishReason,
    MessageRole,
    ModelCapabilities,
    StreamEvent,
    StreamStarted,
    TokenUsage,
    UsageUpdate,
)
from tests.fakes import FakeProvider, response_for


def _request() -> CompletionRequest:
    return CompletionRequest("model", (ChatMessage(MessageRole.USER, "prompt"),))


def _gateway(provider: FakeProvider) -> LLMGateway:
    return LLMGateway(ProviderRegistry((provider,), "fake"), GatewayPolicy())


def test_streaming_contract_yields_typed_events_without_buffering() -> None:
    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield StreamStarted(request.model_identifier)
        yield ContentDelta("part")
        yield UsageUpdate(TokenUsage(2, 1, 3))
        yield CompletionFinished(FinishReason.STOP, TokenUsage(2, 2, 4))

    provider = FakeProvider(
        complete,
        stream,
        capabilities=ModelCapabilities(streaming=True, max_context_tokens=8192),
    )

    async def collect() -> list[StreamEvent]:
        return [event async for event in _gateway(provider).stream(_request())]

    events = asyncio.run(collect())
    assert [type(event) for event in events] == [
        StreamStarted,
        ContentDelta,
        UsageUpdate,
        CompletionFinished,
    ]


def test_streaming_requires_provider_capability() -> None:
    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(_request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        if False:
            yield

    provider = FakeProvider(complete, stream, capabilities=ModelCapabilities(streaming=False))

    async def collect() -> None:
        async for _event in _gateway(provider).stream(_request()):
            pass

    with pytest.raises(UnsupportedCapabilityError):
        asyncio.run(collect())


def test_stream_rejects_missing_started_or_terminal_events() -> None:
    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(_request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield ContentDelta("invalid-first-event")

    provider = FakeProvider(
        complete,
        stream,
        capabilities=ModelCapabilities(streaming=True, max_context_tokens=8192),
    )

    async def collect() -> None:
        async for _event in _gateway(provider).stream(_request()):
            pass

    with pytest.raises(InvalidProviderResponseError):
        asyncio.run(collect())


def test_stream_cancellation_closes_provider_and_releases_capacity() -> None:
    async def exercise() -> tuple[bool, str]:
        entered = asyncio.Event()
        closed = False

        async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
            return response_for(request)

        async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
            nonlocal closed
            try:
                yield StreamStarted(request.model_identifier)
                entered.set()
                await asyncio.Event().wait()
            finally:
                closed = True

        provider = FakeProvider(
            complete,
            stream,
            capabilities=ModelCapabilities(streaming=True, max_context_tokens=8192),
        )
        gateway = _gateway(provider)

        async def consume() -> None:
            async for _event in gateway.stream(_request()):
                pass

        consumer = asyncio.create_task(consume())
        await entered.wait()
        consumer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await consumer
        response = await gateway.complete(_request())
        return closed, response.message.content

    assert asyncio.run(exercise()) == (True, "response")


def test_first_content_token_timeout_is_distinct_and_cancels_iterator() -> None:
    cancelled = False

    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        nonlocal cancelled
        yield StreamStarted(request.model_identifier)
        try:
            await asyncio.Event().wait()
        finally:
            cancelled = True

    async def collect() -> None:
        provider = FakeProvider(complete, stream, capabilities=ModelCapabilities(streaming=True))
        gateway = LLMGateway(
            ProviderRegistry((provider,), "fake"),
            GatewayPolicy(first_token_timeout_seconds=0.01, request_timeout_seconds=1),
        )
        async for _event in gateway.stream(_request()):
            pass

    with pytest.raises(FirstTokenTimeoutError):
        asyncio.run(collect())
    assert cancelled is True


def test_stream_inactivity_timeout_after_content_is_distinct() -> None:
    async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
        return response_for(request)

    async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        yield StreamStarted(request.model_identifier)
        yield ContentDelta("first")
        await asyncio.Event().wait()

    async def collect() -> None:
        provider = FakeProvider(complete, stream, capabilities=ModelCapabilities(streaming=True))
        gateway = LLMGateway(
            ProviderRegistry((provider,), "fake"),
            GatewayPolicy(stream_inactivity_timeout_seconds=0.01, request_timeout_seconds=1),
        )
        async for _event in gateway.stream(_request()):
            pass

    with pytest.raises(StreamInactivityTimeoutError):
        asyncio.run(collect())
