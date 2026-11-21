import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace

from mm_ai_service.application.observability import EventLogger
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    InternalGatewayError,
    InvalidProviderResponseError,
    ProviderTimeoutError,
    ServiceError,
    UnsupportedCapabilityError,
)
from mm_ai_service.domain.llm import (
    STREAM_EVENT_TYPES,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    GenerationOptions,
    MessageRole,
    ModelCapabilities,
    StreamError,
    StreamEvent,
    StreamStarted,
    ThinkingMode,
)


@dataclass(frozen=True, slots=True)
class GatewayPolicy:
    max_concurrency: int = 1
    request_timeout_seconds: float = 120.0
    generation_defaults: GenerationOptions = field(
        default_factory=lambda: GenerationOptions(
            temperature=0.2,
            max_output_tokens=1024,
            context_window=4096,
        )
    )

    def __post_init__(self) -> None:
        if self.max_concurrency <= 0 or self.request_timeout_seconds <= 0:
            raise ValueError("Gateway policy values must be positive")
        defaults = self.generation_defaults
        if (
            defaults.temperature is None
            or defaults.max_output_tokens is None
            or defaults.context_window is None
        ):
            raise ValueError("Gateway generation defaults must be complete")


class LLMGateway:
    """Apply model-neutral policy around one explicitly selected provider."""

    def __init__(
        self,
        registry: ProviderRegistry,
        policy: GatewayPolicy,
        logger: EventLogger | None = None,
    ) -> None:
        self._registry = registry
        self._policy = policy
        self._logger = logger
        self._capacity = asyncio.Semaphore(policy.max_concurrency)

    @property
    def is_available(self) -> bool:
        return self._registry.is_available

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self._event(logging.INFO, "llm.completion_started")
        try:
            provider = self._registry.resolve()
            prepared = self._prepare_request(request, provider.capabilities)
            async with asyncio.timeout(self._policy.request_timeout_seconds):
                async with self._capacity:
                    response = await provider.complete(prepared)
            self._validate_response(response, prepared)
        except asyncio.CancelledError:
            self._event(logging.INFO, "llm.request_cancelled")
            raise
        except TimeoutError:
            timeout_error = ProviderTimeoutError()
            self._log_error(timeout_error)
            raise timeout_error from None
        except ServiceError as gateway_error:
            self._log_error(gateway_error)
            raise
        except Exception:
            internal_error = InternalGatewayError()
            self._log_error(internal_error)
            raise internal_error from None
        self._event(logging.INFO, "llm.completion_finished")
        return response

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        self._event(logging.INFO, "llm.stream_started")
        try:
            provider = self._registry.resolve()
            if not provider.capabilities.streaming:
                raise UnsupportedCapabilityError()
            prepared = self._prepare_request(request, provider.capabilities)
            first_event = True
            terminal_seen = False
            async with asyncio.timeout(self._policy.request_timeout_seconds):
                async with self._capacity:
                    async for event in provider.stream(prepared):
                        if not isinstance(event, STREAM_EVENT_TYPES):
                            raise InvalidProviderResponseError()
                        if first_event and not isinstance(event, StreamStarted):
                            raise InvalidProviderResponseError()
                        if isinstance(event, StreamStarted) and (
                            not first_event or event.model_identifier != prepared.model_identifier
                        ):
                            raise InvalidProviderResponseError()
                        if terminal_seen:
                            raise InvalidProviderResponseError()
                        first_event = False
                        terminal_seen = isinstance(event, (CompletionFinished, StreamError))
                        yield event
            if first_event or not terminal_seen:
                raise InvalidProviderResponseError()
        except asyncio.CancelledError:
            self._event(logging.INFO, "llm.request_cancelled")
            raise
        except TimeoutError:
            timeout_error = ProviderTimeoutError()
            self._log_error(timeout_error)
            raise timeout_error from None
        except ServiceError as gateway_error:
            self._log_error(gateway_error)
            raise
        except Exception:
            internal_error = InternalGatewayError()
            self._log_error(internal_error)
            raise internal_error from None
        self._event(logging.INFO, "llm.stream_finished")

    def _prepare_request(
        self, request: CompletionRequest, capabilities: ModelCapabilities
    ) -> CompletionRequest:
        if not capabilities.chat:
            raise UnsupportedCapabilityError()
        if request.thinking.mode is ThinkingMode.ENABLED and not capabilities.thinking:
            raise UnsupportedCapabilityError()
        if any(message.role is MessageRole.TOOL for message in request.messages) and not (
            capabilities.tool_calling
        ):
            raise UnsupportedCapabilityError()
        options = request.options
        defaults = self._policy.generation_defaults
        resolved_options = GenerationOptions(
            temperature=(
                options.temperature if options.temperature is not None else defaults.temperature
            ),
            max_output_tokens=(
                options.max_output_tokens
                if options.max_output_tokens is not None
                else defaults.max_output_tokens
            ),
            context_window=(
                options.context_window
                if options.context_window is not None
                else defaults.context_window
            ),
            stop_sequences=options.stop_sequences,
        )
        if (
            capabilities.max_context_tokens is not None
            and resolved_options.context_window is not None
            and resolved_options.context_window > capabilities.max_context_tokens
        ):
            raise UnsupportedCapabilityError()
        return replace(request, options=resolved_options)

    @staticmethod
    def _validate_response(response: object, request: CompletionRequest) -> None:
        if not isinstance(response, CompletionResponse):
            raise InvalidProviderResponseError()
        if response.model_identifier != request.model_identifier:
            raise InvalidProviderResponseError()

    def _event(self, level: int, name: str) -> None:
        if self._logger is not None:
            self._logger.event(level, name)

    def _log_error(self, error: ServiceError) -> None:
        if self._logger is not None:
            self._logger.event(
                logging.WARNING,
                "llm.request_failed",
                metadata={"error_code": error.code},
            )
