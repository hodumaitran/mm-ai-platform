import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from mm_ai_service.application.observability import EventLogger
from mm_ai_service.domain.errors import ServiceError
from mm_ai_service.presentation.request_context import REQUEST_ID_HEADER


def _request_id(request: Request) -> str:
    value = getattr(request.state, "request_id", None)
    return value if isinstance(value, str) else "unavailable"


def _response(request: Request, status_code: int, code: str, message: str) -> JSONResponse:
    request_id = _request_id(request)
    content: dict[str, Any] = {
        "error": {"code": code, "message": message, "request_id": request_id}
    }
    return JSONResponse(
        status_code=status_code,
        content=content,
        headers={REQUEST_ID_HEADER: request_id},
    )


def register_error_handlers(app: FastAPI, logger: EventLogger) -> None:
    async def service_error_handler(request: Request, error: ServiceError) -> JSONResponse:
        logger.event(
            logging.WARNING,
            "http.service_error",
            request_id=_request_id(request),
            metadata={"error_code": error.code, "status_code": error.status_code},
        )
        return _response(request, error.status_code, error.code, error.public_message)

    async def validation_error_handler(
        request: Request, _error: RequestValidationError
    ) -> JSONResponse:
        return _response(request, 422, "INVALID_REQUEST", "The request is invalid.")

    async def unhandled_error_handler(request: Request, error: Exception) -> JSONResponse:
        logger.event(
            logging.ERROR,
            "http.internal_error",
            request_id=_request_id(request),
            metadata={
                "error_code": "INTERNAL_ERROR",
                "exception_type": type(error).__name__,
                "status_code": 500,
            },
        )
        return _response(
            request,
            500,
            "INTERNAL_ERROR",
            "An unexpected error occurred.",
        )

    app.add_exception_handler(ServiceError, service_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_error_handler)
