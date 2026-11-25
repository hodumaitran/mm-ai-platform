import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from starlette.types import Message

from mm_ai_service.application.gateway import LLMGateway
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.application.readiness import (
    ProviderReadiness,
    Readiness,
    ReadinessProbe,
    describe_readiness,
)
from mm_ai_service.config import Settings
from mm_ai_service.domain.errors import InternalGatewayError, RequestCancelledError, ServiceError
from mm_ai_service.domain.llm import CompletionFinished, ContentDelta, StreamError, UsageUpdate
from mm_ai_service.presentation.chat_contracts import ChatCompletionResponse
from mm_ai_service.presentation.chat_transport import (
    completion_response,
    read_chat_request,
    request_timeout_seconds,
    safe_stream_error,
    sse_event,
    to_domain_request,
)


async def _await_or_disconnect[T](
    operation: Awaitable[T],
    receive: Callable[[], Awaitable[Message]],
) -> T:
    operation_task: asyncio.Future[T] = asyncio.ensure_future(operation)
    disconnect_task = asyncio.create_task(_wait_for_disconnect(receive))
    try:
        done, _pending = await asyncio.wait(
            (operation_task, disconnect_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if disconnect_task in done and operation_task not in done:
            operation_task.cancel()
            await asyncio.gather(operation_task, return_exceptions=True)
            raise RequestCancelledError()
        return await operation_task
    finally:
        disconnect_task.cancel()
        await asyncio.gather(disconnect_task, return_exceptions=True)


async def _wait_for_disconnect(receive: Callable[[], Awaitable[Message]]) -> None:
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return


def create_operations_router(
    settings: Settings,
    gateway: LLMGateway,
    readiness_probe: ReadinessProbe | None = None,
    logger: EventLogger | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health() -> dict[str, Literal["ai-service", "ok"]]:
        """Report process liveness only."""
        return {"service": "ai-service", "status": "ok"}

    @router.get("/ready")
    async def ready() -> Readiness:
        """Report only capabilities implemented in this checkpoint."""
        provider = (
            await readiness_probe.check_readiness()
            if readiness_probe is not None and gateway.is_available
            else ProviderReadiness()
        )
        return describe_readiness(settings.env, provider)

    @router.post("/v1/chat/completions", response_model=ChatCompletionResponse, tags=["chat"])
    async def chat_completion(request: Request) -> ChatCompletionResponse:
        started = time.perf_counter()
        request_id = request.state.request_id
        payload = await read_chat_request(request, settings)
        response = await _await_or_disconnect(
            gateway.complete(
                to_domain_request(payload, settings),
                timeout_seconds=request_timeout_seconds(request, settings),
            ),
            request.receive,
        )
        result = completion_response(response, request_id)
        if logger is not None:
            logger.event(
                logging.INFO,
                "chat.completion_finished",
                request_id=request_id,
                metadata={
                    "completion_tokens": response.usage.completion_tokens,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                    "outcome": "completed",
                    "prompt_tokens": response.usage.prompt_tokens,
                    "provider_identifier": settings.llm_provider,
                    "route": "/v1/chat/completions",
                    "status_code": 200,
                },
            )
        return result

    @router.post("/v1/chat/completions/stream", tags=["chat"])
    async def chat_completion_stream(request: Request) -> StreamingResponse:
        request_id = request.state.request_id
        started = time.perf_counter()
        payload = await read_chat_request(request, settings)
        stream = gateway.stream(
            to_domain_request(payload, settings),
            timeout_seconds=request_timeout_seconds(request, settings),
        )
        try:
            first_event = await _await_or_disconnect(anext(stream), request.receive)
        except BaseException:
            await stream.aclose()
            raise

        async def generate() -> AsyncIterator[bytes]:
            terminal = isinstance(first_event, (CompletionFinished, StreamError))
            first_content_ms: float | None = None
            prompt_tokens: int | None = None
            completion_tokens: int | None = None
            try:
                yield sse_event(first_event, request_id)
                async for event in stream:
                    if isinstance(event, ContentDelta) and first_content_ms is None:
                        first_content_ms = round((time.perf_counter() - started) * 1000, 3)
                    if isinstance(event, (UsageUpdate, CompletionFinished)):
                        prompt_tokens = event.usage.prompt_tokens
                        completion_tokens = event.usage.completion_tokens
                    terminal = isinstance(event, (CompletionFinished, StreamError))
                    yield sse_event(event, request_id)
                if logger is not None:
                    logger.event(
                        logging.INFO,
                        "chat.stream_finished",
                        request_id=request_id,
                        metadata={
                            "completion_tokens": completion_tokens,
                            "duration_ms": round((time.perf_counter() - started) * 1000, 3),
                            "outcome": "completed",
                            "prompt_tokens": prompt_tokens,
                            "provider_identifier": settings.llm_provider,
                            "route": "/v1/chat/completions/stream",
                            "status_code": 200,
                            "time_to_first_content_ms": first_content_ms,
                        },
                    )
            except asyncio.CancelledError:
                if logger is not None:
                    logger.event(
                        logging.INFO,
                        "chat.stream_cancelled",
                        request_id=request_id,
                        metadata={"path": "/v1/chat/completions/stream"},
                    )
                raise
            except ServiceError as error:
                if not terminal:
                    terminal = True
                    yield safe_stream_error(error.code, error.public_message, request_id)
            except Exception:
                if not terminal:
                    internal = InternalGatewayError()
                    yield safe_stream_error(internal.code, internal.public_message, request_id)
            finally:
                await stream.aclose()

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "X-Accel-Buffering": "no",
            },
        )

    return router
