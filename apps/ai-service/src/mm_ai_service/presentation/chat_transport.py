import asyncio
import json
import time

from pydantic import ValidationError
from starlette.requests import ClientDisconnect, Request

from mm_ai_service.config import Settings
from mm_ai_service.domain.errors import (
    InvalidCompletionRequestError,
    InvalidRequestError,
    PayloadTooLargeError,
    UnsupportedMediaTypeError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    GenerationOptions,
    MessageRole,
    StreamError,
    StreamEvent,
    StreamStarted,
    ThinkingConfiguration,
    ThinkingMode,
    TokenUsage,
    UsageUpdate,
)
from mm_ai_service.presentation.chat_contracts import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessageResponse,
    PublicMessageRole,
    PublicThinkingMode,
    TokenUsageResponse,
)

REQUEST_TIMEOUT_HEADER = "X-Request-Timeout-Ms"


async def read_chat_request(request: Request, settings: Settings) -> ChatCompletionRequest:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise UnsupportedMediaTypeError()
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError:
            raise InvalidRequestError() from None
        if declared_length < 0:
            raise InvalidRequestError()
        if declared_length > settings.chat_max_body_bytes:
            raise PayloadTooLargeError()
    body = bytearray()
    try:
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > settings.chat_max_body_bytes:
                raise PayloadTooLargeError()
    except ClientDisconnect:
        raise asyncio.CancelledError() from None
    try:
        parsed = ChatCompletionRequest.model_validate_json(body, strict=True)
    except ValidationError:
        raise InvalidRequestError() from None
    _validate_transport_budget(parsed, settings)
    return parsed


def request_timeout_seconds(request: Request, settings: Settings) -> float:
    raw = request.headers.get(REQUEST_TIMEOUT_HEADER)
    if raw is None:
        return settings.llm_request_timeout_seconds
    try:
        milliseconds = int(raw)
    except ValueError:
        raise InvalidRequestError() from None
    if milliseconds <= 0:
        raise InvalidRequestError()
    received = getattr(request.state, "request_started_monotonic", time.monotonic())
    elapsed = max(0.0, time.monotonic() - received)
    remaining = milliseconds / 1000 - elapsed
    if remaining <= 0:
        raise InvalidRequestError("The request deadline has expired.")
    return min(remaining, settings.llm_request_timeout_seconds)


def to_domain_request(payload: ChatCompletionRequest, settings: Settings) -> CompletionRequest:
    roles = {
        PublicMessageRole.USER: MessageRole.USER,
        PublicMessageRole.ASSISTANT: MessageRole.ASSISTANT,
    }
    thinking = (
        ThinkingMode.ENABLED
        if payload.thinking.mode is PublicThinkingMode.ENABLED
        else ThinkingMode.DISABLED
    )
    try:
        return CompletionRequest(
            settings.ollama_model,
            tuple(ChatMessage(roles[item.role], item.content) for item in payload.messages),
            GenerationOptions(
                temperature=payload.generation.temperature,
                max_output_tokens=payload.generation.max_output_tokens,
                context_window=settings.llm_default_context_window,
            ),
            ThinkingConfiguration(thinking),
        )
    except InvalidCompletionRequestError:
        raise InvalidRequestError() from None


def completion_response(response: CompletionResponse, request_id: str) -> ChatCompletionResponse:
    return ChatCompletionResponse(
        request_id=request_id,
        model=response.model_identifier,
        message=ChatMessageResponse(role="assistant", content=response.message.content),
        finish_reason=response.finish_reason.value,
        usage=_usage(response.usage),
    )


def sse_event(event: StreamEvent, request_id: str) -> bytes:
    if isinstance(event, StreamStarted):
        name = "stream.started"
        payload: dict[str, object] = {
            "version": "1",
            "request_id": request_id,
            "model": event.model_identifier,
        }
    elif isinstance(event, ContentDelta):
        name = "content.delta"
        payload = {"version": "1", "request_id": request_id, "content": event.content}
    elif isinstance(event, UsageUpdate):
        name = "usage.updated"
        payload = {
            "version": "1",
            "request_id": request_id,
            "usage": _usage(event.usage).model_dump(),
        }
    elif isinstance(event, CompletionFinished):
        name = "stream.completed"
        payload = {
            "version": "1",
            "request_id": request_id,
            "finish_reason": event.finish_reason.value,
            "usage": _usage(event.usage).model_dump(),
        }
    elif isinstance(event, StreamError):
        name = "stream.error"
        payload = {
            "version": "1",
            "request_id": request_id,
            "error": {"code": event.code, "message": event.message},
        }
    else:
        raise TypeError("unsupported stream event")
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {encoded}\n\n".encode()


def safe_stream_error(code: str, message: str, request_id: str) -> bytes:
    return sse_event(StreamError(code, message), request_id)


def _validate_transport_budget(payload: ChatCompletionRequest, settings: Settings) -> None:
    if len(payload.messages) > settings.chat_max_messages:
        raise InvalidRequestError()
    lengths = [len(message.content) for message in payload.messages]
    if any(length > settings.chat_max_message_characters for length in lengths):
        raise InvalidRequestError()
    total_input = sum(lengths)
    output = payload.generation.max_output_tokens
    if (
        total_input > settings.chat_max_input_characters
        or output > settings.chat_max_output_tokens
        or total_input + output > settings.llm_default_context_window
    ):
        raise InvalidRequestError()


def _usage(usage: TokenUsage) -> TokenUsageResponse:
    return TokenUsageResponse(
        prompt_tokens=usage.prompt_tokens,
        completion_tokens=usage.completion_tokens,
        total_tokens=usage.total_tokens,
    )
