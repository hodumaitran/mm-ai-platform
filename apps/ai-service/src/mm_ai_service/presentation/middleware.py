import logging
import time

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from mm_ai_service.application.observability import EventLogger
from mm_ai_service.presentation.request_context import (
    REQUEST_ID_HEADER,
    reset_request_id,
    resolve_request_id,
    set_request_id,
)


class RequestContextMiddleware:
    """Correlate one HTTP request without leaking context across async tasks."""

    def __init__(self, app: ASGIApp, logger: EventLogger) -> None:
        self.app = app
        self.logger = logger

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        raw_candidate = headers.get(REQUEST_ID_HEADER.lower().encode("ascii"))
        candidate = raw_candidate.decode("latin-1") if raw_candidate else None
        request_id = resolve_request_id(candidate)
        scope.setdefault("state", {})["request_id"] = request_id
        token = set_request_id(request_id)
        started = time.perf_counter()
        status_code = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                response_headers = MutableHeaders(scope=message)
                response_headers[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 3)
            self.logger.event(
                logging.INFO,
                "http.request_completed",
                request_id=request_id,
                metadata={
                    "method": scope.get("method", ""),
                    "path": scope.get("path", ""),
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                },
            )
            reset_request_id(token)
