from collections.abc import AsyncIterator, Awaitable, Callable

from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionRequest,
    CompletionResponse,
    FinishReason,
    MessageRole,
    ModelCapabilities,
    StreamEvent,
    TokenUsage,
)

CompletionHandler = Callable[[CompletionRequest], Awaitable[CompletionResponse]]
StreamHandler = Callable[[CompletionRequest], AsyncIterator[StreamEvent]]


class FakeProvider:
    """Deterministic in-memory provider used only by gateway tests."""

    def __init__(
        self,
        completion_handler: CompletionHandler,
        stream_handler: StreamHandler,
        *,
        provider_id: str = "fake",
        capabilities: ModelCapabilities | None = None,
    ) -> None:
        self._provider_id = provider_id
        self._capabilities = capabilities or ModelCapabilities(max_context_tokens=8192)
        self._completion_handler = completion_handler
        self._stream_handler = stream_handler

    @property
    def provider_id(self) -> str:
        return self._provider_id

    @property
    def capabilities(self) -> ModelCapabilities:
        return self._capabilities

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        return await self._completion_handler(request)

    def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        return self._stream_handler(request)


def response_for(
    request: CompletionRequest,
    *,
    content: str = "response",
    usage: TokenUsage | None = None,
) -> CompletionResponse:
    return CompletionResponse(
        model_identifier=request.model_identifier,
        message=ChatMessage(MessageRole.ASSISTANT, content),
        finish_reason=FinishReason.STOP,
        usage=usage or TokenUsage.unavailable(),
    )


async def empty_stream(_request: CompletionRequest) -> AsyncIterator[StreamEvent]:
    if False:
        yield
