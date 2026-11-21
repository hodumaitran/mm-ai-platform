from collections.abc import Callable
from dataclasses import FrozenInstanceError
from typing import cast

import pytest

from mm_ai_service.domain.errors import InvalidCompletionRequestError
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    FinishReason,
    GenerationOptions,
    MessageRole,
    Metadata,
    ModelCapabilities,
    StreamError,
    StreamStarted,
    ThinkingConfiguration,
    ThinkingMode,
    TokenUsage,
    UsageUpdate,
)


def test_completion_contracts_are_immutable_and_provider_neutral() -> None:
    request = CompletionRequest(
        "model.family:version",
        (ChatMessage(MessageRole.USER, "hello"),),
        GenerationOptions(temperature=0.2, max_output_tokens=128, context_window=4096),
        ThinkingConfiguration(ThinkingMode.DEFAULT),
    )
    response = CompletionResponse(
        request.model_identifier,
        ChatMessage(MessageRole.ASSISTANT, "answer"),
        FinishReason.STOP,
        TokenUsage(10, 2, 12),
        (("cached", False),),
    )
    assert response.usage.total_tokens == 12
    with pytest.raises(FrozenInstanceError):
        request.model_identifier = "other"  # type: ignore[misc]


@pytest.mark.parametrize(
    "factory",
    [
        lambda: ChatMessage(MessageRole.USER, " "),
        lambda: ChatMessage(cast(MessageRole, "invalid"), "content"),
        lambda: CompletionRequest("invalid model", (ChatMessage(MessageRole.USER, "x"),)),
        lambda: CompletionRequest("valid", ()),
        lambda: GenerationOptions(temperature=-0.1),
        lambda: GenerationOptions(temperature=2.1),
        lambda: GenerationOptions(temperature=float("nan")),
        lambda: GenerationOptions(max_output_tokens=cast(int, True)),
        lambda: GenerationOptions(max_output_tokens=0),
        lambda: GenerationOptions(max_output_tokens=20, context_window=10),
        lambda: GenerationOptions(stop_sequences=("",)),
        lambda: TokenUsage(prompt_tokens=-1),
        lambda: TokenUsage(1, 2, 4),
        lambda: TokenUsage(prompt_tokens=cast(int, True)),
        lambda: ModelCapabilities(max_context_tokens=0),
        lambda: ThinkingConfiguration(cast(ThinkingMode, "sometimes")),
    ],
)
def test_invalid_completion_contracts_are_rejected(factory: object) -> None:
    with pytest.raises(InvalidCompletionRequestError):
        cast(Callable[[], object], factory)()


def test_usage_can_be_explicitly_unavailable_without_fabrication() -> None:
    usage = TokenUsage.unavailable()
    assert usage.prompt_tokens is None
    assert usage.completion_tokens is None
    assert usage.total_tokens is None


def test_response_metadata_is_bounded_to_immutable_safe_scalars() -> None:
    message = ChatMessage(MessageRole.ASSISTANT, "answer")
    response = CompletionResponse(
        "model",
        message,
        FinishReason.STOP,
        metadata=(("cache.hit", True),),
    )
    assert response.metadata == (("cache.hit", True),)
    with pytest.raises(InvalidCompletionRequestError):
        CompletionResponse(
            "model",
            message,
            FinishReason.STOP,
            metadata=cast(Metadata, (("unsafe", []),)),
        )


def test_typed_stream_events_validate_payloads() -> None:
    events = (
        StreamStarted("model"),
        ContentDelta("part"),
        UsageUpdate(TokenUsage(1, 1, 2)),
        CompletionFinished(FinishReason.STOP, TokenUsage(1, 2, 3)),
        StreamError("PROVIDER_OVERLOAD", "The provider is overloaded."),
    )
    assert len(events) == 5
    with pytest.raises(InvalidCompletionRequestError):
        ContentDelta("")
