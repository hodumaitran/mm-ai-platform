from collections.abc import AsyncIterator
from typing import Protocol

from mm_ai_service.domain.llm import (
    CompletionRequest,
    CompletionResponse,
    ModelCapabilities,
    StreamEvent,
)


class LLMProvider(Protocol):
    """Provider-neutral async contract implemented by infrastructure adapters.

    Implementations must propagate caller cancellation, normalize transport failures into the
    gateway error taxonomy, and never log prompts, completions, or reasoning traces.
    """

    @property
    def provider_id(self) -> str: ...

    @property
    def capabilities(self) -> ModelCapabilities: ...

    async def complete(self, request: CompletionRequest) -> CompletionResponse: ...

    def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]: ...
