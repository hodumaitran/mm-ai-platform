import asyncio
import os
import time
from collections.abc import AsyncIterator

import httpx
import pytest

from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    ModelUnavailableError,
    ProviderConnectionError,
    ProviderTimeoutError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    FinishReason,
    GenerationOptions,
    MessageRole,
    ModelCapabilities,
    StreamEvent,
    StreamStarted,
    ThinkingConfiguration,
    ThinkingMode,
)
from mm_ai_service.infrastructure.ollama import OllamaProvider

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("AI_SERVICE_RUN_OLLAMA_INTEGRATION") != "1",
        reason="set AI_SERVICE_RUN_OLLAMA_INTEGRATION=1 for local Ollama tests",
    ),
]

BASE_URL = os.getenv("AI_SERVICE_OLLAMA_BASE_URL", "http://127.0.0.1:11434")
MODEL = os.getenv("AI_SERVICE_OLLAMA_MODEL", "qwen3.5:35b")


def _provider(model: str = MODEL) -> OllamaProvider:
    return OllamaProvider(
        base_url=BASE_URL,
        model=model,
        context_window=4096,
        connect_timeout_seconds=5,
        read_timeout_seconds=300,
        readiness_timeout_seconds=3,
        readiness_cache_seconds=10,
    )


def _request(content: str, thinking: ThinkingMode, *, limit: int = 24) -> CompletionRequest:
    return CompletionRequest(
        MODEL,
        (ChatMessage(MessageRole.USER, content),),
        GenerationOptions(temperature=0.2, max_output_tokens=limit, context_window=4096),
        ThinkingConfiguration(thinking),
    )


def _gateway(provider: OllamaProvider, *, timeout: float = 300) -> LLMGateway:
    return LLMGateway(
        ProviderRegistry((provider,), "ollama"),
        GatewayPolicy(max_concurrency=1, request_timeout_seconds=timeout),
    )


def _model_is_installed() -> bool:
    with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
        response = client.get(f"{BASE_URL}/api/tags")
        response.raise_for_status()
        payload = response.json()
    models = payload.get("models", []) if isinstance(payload, dict) else []
    return any(
        isinstance(item, dict) and (item.get("name") == MODEL or item.get("model") == MODEL)
        for item in models
    )


def _require_model() -> None:
    if not _model_is_installed():
        pytest.skip(f"configured local model is not installed: {MODEL}")


def test_live_ollama_connectivity_and_version() -> None:
    started = time.perf_counter()
    with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
        response = client.get(f"{BASE_URL}/api/version")
    latency = time.perf_counter() - started
    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload.get("version"), str)
    print(f"ollama_version_latency_seconds={latency:.4f}")


def test_live_configured_model_is_available_and_compatible() -> None:
    _require_model()

    async def exercise() -> None:
        provider = _provider()
        await provider.start()
        state = await provider.check_readiness()
        assert state.provider_available is True
        assert state.model_available is True
        assert state.inference_available is True
        await provider.stop()

    asyncio.run(exercise())


def test_live_invalid_model_is_normalized_without_pull() -> None:
    missing = "mm-ai-definitely-missing:model"

    async def exercise() -> None:
        provider = _provider(missing)
        await provider.start()
        request = CompletionRequest(
            missing,
            (ChatMessage(MessageRole.USER, "Reply with one word."),),
            GenerationOptions(max_output_tokens=4, context_window=128),
        )
        with pytest.raises(ModelUnavailableError):
            await provider.complete(request)
        await provider.stop()

    asyncio.run(exercise())


def test_live_unavailable_ollama_is_normalized() -> None:
    async def exercise() -> None:
        provider = OllamaProvider(
            base_url="http://127.0.0.1:9",
            model=MODEL,
            context_window=4096,
            connect_timeout_seconds=0.1,
            read_timeout_seconds=0.1,
            readiness_timeout_seconds=0.1,
            readiness_cache_seconds=0,
        )
        await provider.start()
        state = await provider.check_readiness()
        assert state.provider_available is False
        with pytest.raises(ProviderConnectionError):
            await provider.complete(_request("Hello", ThinkingMode.DISABLED, limit=4))
        await provider.stop()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("prompt", "thinking"),
    [
        ("Trả lời đúng một từ: thủ đô Việt Nam là gì?", ThinkingMode.DISABLED),
        ("Reply with one word: what color is a clear daytime sky?", ThinkingMode.ENABLED),
    ],
)
def test_live_bounded_completion_and_normalization(
    prompt: str,
    thinking: ThinkingMode,
) -> None:
    _require_model()

    async def exercise() -> None:
        provider = _provider()
        await provider.start()
        if thinking is ThinkingMode.ENABLED and not provider.capabilities.thinking:
            await provider.stop()
            pytest.skip("installed model does not advertise thinking support")
        gateway = _gateway(provider)
        started = time.perf_counter()
        output_limit = 256 if thinking is ThinkingMode.ENABLED else 64
        response = await gateway.complete(_request(prompt, thinking, limit=output_limit))
        latency = time.perf_counter() - started
        assert response.model_identifier == MODEL
        assert response.message.role is MessageRole.ASSISTANT
        assert response.message.content.strip()
        assert response.usage.prompt_tokens is None or response.usage.prompt_tokens >= 0
        assert response.usage.completion_tokens is None or response.usage.completion_tokens >= 0
        assert response.finish_reason in (FinishReason.STOP, FinishReason.LENGTH)
        completion_tokens = response.usage.completion_tokens
        rate = completion_tokens / latency if completion_tokens is not None else None
        rate_text = f"{rate:.4f}" if rate is not None else "unknown"
        print(
            f"completion_mode={thinking.value} latency_seconds={latency:.4f} "
            f"prompt_tokens={response.usage.prompt_tokens} "
            f"completion_tokens={completion_tokens} "
            f"tokens_per_second={rate_text} "
            f"finish_reason={response.finish_reason.value} "
            f"output_characters={len(response.message.content)}"
        )
        await provider.stop()

    asyncio.run(exercise())


def test_live_gateway_ndjson_streaming_and_time_to_first_token() -> None:
    _require_model()

    async def exercise() -> None:
        provider = _provider()
        await provider.start()
        gateway = _gateway(provider)
        started = time.perf_counter()
        first_content_at: float | None = None
        content_parts: list[str] = []
        events: list[StreamEvent] = []
        async for event in gateway.stream(
            _request(
                "Reply in one short sentence: what is local inference?",
                ThinkingMode.DISABLED,
                limit=48,
            )
        ):
            events.append(event)
            if isinstance(event, ContentDelta):
                if first_content_at is None:
                    first_content_at = time.perf_counter()
                content_parts.append(event.content)
        elapsed = time.perf_counter() - started
        assert isinstance(events[0], StreamStarted)
        assert isinstance(events[-1], CompletionFinished)
        assert content_parts
        assert first_content_at is not None
        finished = events[-1]
        assert isinstance(finished, CompletionFinished)
        assert finished.finish_reason in (FinishReason.STOP, FinishReason.LENGTH)
        print(
            f"stream_latency_seconds={elapsed:.4f} "
            f"time_to_first_token_seconds={first_content_at - started:.4f} "
            f"prompt_tokens={finished.usage.prompt_tokens} "
            f"completion_tokens={finished.usage.completion_tokens} "
            f"finish_reason={finished.finish_reason.value} "
            f"content_events={len(content_parts)}"
        )
        await provider.stop()

    asyncio.run(exercise())


def test_live_gateway_timeout_and_cancellation() -> None:
    _require_model()

    async def exercise() -> None:
        provider = _provider()
        await provider.start()
        timeout_gateway = LLMGateway(
            ProviderRegistry((provider,), "ollama"),
            GatewayPolicy(max_concurrency=1, request_timeout_seconds=0.001),
        )
        with pytest.raises(ProviderTimeoutError):
            await timeout_gateway.complete(
                _request("Reply briefly: explain gravity.", ThinkingMode.DISABLED, limit=64)
            )

        gateway = _gateway(provider)
        task = asyncio.create_task(
            gateway.complete(
                _request("Reply briefly: explain photosynthesis.", ThinkingMode.DISABLED, limit=64)
            )
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await provider.stop()

    asyncio.run(exercise())


class CountingProvider:
    def __init__(self, delegate: OllamaProvider) -> None:
        self._delegate = delegate
        self.active = 0
        self.maximum = 0

    @property
    def provider_id(self) -> str:
        return self._delegate.provider_id

    @property
    def capabilities(self) -> ModelCapabilities:
        return self._delegate.capabilities

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self.active += 1
        self.maximum = max(self.maximum, self.active)
        try:
            return await self._delegate.complete(request)
        finally:
            self.active -= 1

    def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        return self._delegate.stream(request)


def test_live_gateway_concurrency_limit_one() -> None:
    _require_model()

    async def exercise() -> None:
        provider = _provider()
        await provider.start()
        counted = CountingProvider(provider)
        gateway = LLMGateway(
            ProviderRegistry((counted,), "ollama"),
            GatewayPolicy(max_concurrency=1, request_timeout_seconds=300),
        )
        await asyncio.gather(
            gateway.complete(_request("Reply with: one", ThinkingMode.DISABLED, limit=8)),
            gateway.complete(_request("Reply with: two", ThinkingMode.DISABLED, limit=8)),
        )
        assert counted.maximum == 1
        await provider.stop()

    asyncio.run(exercise())


def test_live_native_tool_call_is_parsed_validated_and_executed() -> None:
    _require_model()

    async def exercise() -> None:
        from mm_ai_service.application.demo_tools import CALCULATE, build_demo_registry
        from mm_ai_service.application.tools import ToolExecutionPolicy, ToolExecutor
        from mm_ai_service.domain.tools import ToolOutcome

        provider = _provider()
        await provider.start()
        assert provider.capabilities.tool_calling is True
        gateway = _gateway(provider)
        request = CompletionRequest(
            MODEL,
            (ChatMessage(MessageRole.USER, "Use the calculate tool to multiply 6 by 7."),),
            GenerationOptions(temperature=0.0, max_output_tokens=200, context_window=4096),
            ThinkingConfiguration(ThinkingMode.DISABLED),
            tools=(CALCULATE,),
        )
        response = await gateway.complete(request, timeout_seconds=280)
        assert response.finish_reason is FinishReason.TOOL_CALL
        (call,) = response.message.tool_calls
        assert call.tool_name == "calculate"
        registry = build_demo_registry()
        executor = ToolExecutor(registry, ToolExecutionPolicy(allowed_tools=registry.names))
        execution = await executor.execute(call, timeout_seconds=10)
        assert execution.result.outcome is ToolOutcome.SUCCEEDED
        assert '"result":42' in execution.result.content
        await provider.stop()

    asyncio.run(exercise())
