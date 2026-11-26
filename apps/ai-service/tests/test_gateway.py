import asyncio
import io
from typing import cast

import pytest

from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    InternalGatewayError,
    InvalidProviderResponseError,
    NoProviderConfiguredError,
    ProviderConnectionError,
    ProviderOverloadError,
    ProviderTimeoutError,
    UnknownProviderError,
    UnsupportedCapabilityError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionRequest,
    CompletionResponse,
    GenerationOptions,
    MessageRole,
    ModelCapabilities,
    ThinkingConfiguration,
    ThinkingMode,
    TokenUsage,
)
from mm_ai_service.infrastructure.logging import build_service_logger
from tests.fakes import FakeProvider, empty_stream, response_for


def _request(
    *,
    options: GenerationOptions | None = None,
    thinking: ThinkingMode = ThinkingMode.DEFAULT,
    content: str = "prompt",
) -> CompletionRequest:
    return CompletionRequest(
        "model:1",
        (ChatMessage(MessageRole.USER, content),),
        options or GenerationOptions(),
        ThinkingConfiguration(thinking),
    )


def _gateway(
    provider: FakeProvider,
    *,
    timeout: float = 1,
    concurrency: int = 1,
    logger: EventLogger | None = None,
) -> LLMGateway:
    return LLMGateway(
        ProviderRegistry((provider,), provider.provider_id),
        GatewayPolicy(max_concurrency=concurrency, request_timeout_seconds=timeout),
        logger=logger,
    )


def test_successful_completion_applies_explicit_defaults_and_preserves_usage() -> None:
    seen: list[CompletionRequest] = []

    async def complete(request: CompletionRequest) -> CompletionResponse:
        seen.append(request)
        return response_for(request, usage=TokenUsage(8, 3, 11))

    provider = FakeProvider(complete, empty_stream)
    response = asyncio.run(_gateway(provider).complete(_request()))
    assert response.usage == TokenUsage(8, 3, 11)
    assert seen[0].options == GenerationOptions(
        temperature=0.2,
        max_output_tokens=1024,
        context_window=4096,
    )


@pytest.mark.parametrize("mode", [ThinkingMode.DEFAULT, ThinkingMode.DISABLED])
def test_non_enabled_thinking_works_without_provider_support(mode: ThinkingMode) -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request)

    provider = FakeProvider(complete, empty_stream, capabilities=ModelCapabilities(thinking=False))
    assert asyncio.run(_gateway(provider).complete(_request(thinking=mode))).message.content


def test_thinking_enabled_works_with_provider_capability() -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request)

    provider = FakeProvider(
        complete,
        empty_stream,
        capabilities=ModelCapabilities(thinking=True, max_context_tokens=8192),
    )
    response = asyncio.run(_gateway(provider).complete(_request(thinking=ThinkingMode.ENABLED)))
    assert response.message.content == "response"


def test_thinking_enabled_requires_capability() -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request)

    provider = FakeProvider(complete, empty_stream, capabilities=ModelCapabilities(thinking=False))
    with pytest.raises(UnsupportedCapabilityError):
        asyncio.run(_gateway(provider).complete(_request(thinking=ThinkingMode.ENABLED)))


@pytest.mark.parametrize(
    "capabilities,options",
    [
        (ModelCapabilities(chat=False), GenerationOptions()),
        (ModelCapabilities(max_context_tokens=2048), GenerationOptions(context_window=4096)),
    ],
)
def test_gateway_rejects_unsupported_capabilities(
    capabilities: ModelCapabilities, options: GenerationOptions
) -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request)

    provider = FakeProvider(complete, empty_stream, capabilities=capabilities)
    with pytest.raises(UnsupportedCapabilityError):
        asyncio.run(_gateway(provider).complete(_request(options=options)))


def test_tool_messages_require_tool_calling_capability() -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request)

    request = CompletionRequest(
        "model",
        (ChatMessage(MessageRole.TOOL, "tool result", tool_call_id="c1", tool_name="calculate"),),
    )
    provider = FakeProvider(complete, empty_stream, capabilities=ModelCapabilities())
    with pytest.raises(UnsupportedCapabilityError):
        asyncio.run(_gateway(provider).complete(request))


def test_gateway_reports_no_configured_or_unknown_provider() -> None:
    no_provider = LLMGateway(ProviderRegistry((), None), GatewayPolicy())
    unknown = LLMGateway(ProviderRegistry((), "missing"), GatewayPolicy())
    with pytest.raises(NoProviderConfiguredError):
        asyncio.run(no_provider.complete(_request()))
    with pytest.raises(UnknownProviderError):
        asyncio.run(unknown.complete(_request()))


def test_end_to_end_timeout_normalizes_provider_timeout() -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        await asyncio.sleep(0.1)
        return response_for(request)

    provider = FakeProvider(complete, empty_stream)
    with pytest.raises(ProviderTimeoutError):
        asyncio.run(_gateway(provider, timeout=0.01).complete(_request()))


@pytest.mark.parametrize("provider_error", [ProviderConnectionError(), ProviderOverloadError()])
def test_provider_failures_remain_normalized(provider_error: Exception) -> None:
    async def complete(_request: CompletionRequest) -> CompletionResponse:
        raise provider_error

    provider = FakeProvider(complete, empty_stream)
    with pytest.raises(type(provider_error)):
        asyncio.run(_gateway(provider).complete(_request()))


def test_unknown_provider_exception_becomes_internal_gateway_failure() -> None:
    async def complete(_request: CompletionRequest) -> CompletionResponse:
        raise RuntimeError("private provider detail")

    provider = FakeProvider(complete, empty_stream)
    with pytest.raises(InternalGatewayError) as captured:
        asyncio.run(_gateway(provider).complete(_request()))
    assert "private provider detail" not in captured.value.public_message


def test_invalid_provider_response_is_rejected() -> None:
    async def complete(_request: CompletionRequest) -> CompletionResponse:
        return cast(CompletionResponse, object())

    provider = FakeProvider(complete, empty_stream)
    with pytest.raises(InvalidProviderResponseError):
        asyncio.run(_gateway(provider).complete(_request()))


def test_unavailable_usage_remains_unknown() -> None:
    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request, usage=TokenUsage.unavailable())

    response = asyncio.run(_gateway(FakeProvider(complete, empty_stream)).complete(_request()))
    assert response.usage == TokenUsage(None, None, None)


def test_gateway_logs_no_prompt_completion_or_reasoning_content() -> None:
    stream = io.StringIO()

    async def complete(request: CompletionRequest) -> CompletionResponse:
        return response_for(request, content="completion-secret")

    provider = FakeProvider(complete, empty_stream)
    response = asyncio.run(
        _gateway(provider, logger=build_service_logger("INFO", stream)).complete(
            _request(content="prompt-secret")
        )
    )
    assert response.message.content == "completion-secret"
    output = stream.getvalue()
    assert "prompt-secret" not in output
    assert "completion-secret" not in output
