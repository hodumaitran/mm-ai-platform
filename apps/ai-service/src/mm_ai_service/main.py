"""AI service composition root.

Only this module wires concrete infrastructure and presentation concerns together.
"""

from collections.abc import Sequence

from fastapi import FastAPI

from mm_ai_service.application.lifecycle import ManagedResource
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.config import Settings, load_settings
from mm_ai_service.infrastructure.lifecycle import application_lifespan
from mm_ai_service.infrastructure.logging import build_service_logger
from mm_ai_service.presentation.errors import register_error_handlers
from mm_ai_service.presentation.middleware import RequestContextMiddleware
from mm_ai_service.presentation.routes import create_operations_router


def create_app(
    settings: Settings | None = None,
    *,
    resources: Sequence[ManagedResource] = (),
    logger: EventLogger | None = None,
) -> FastAPI:
    """Build an isolated application instance from explicit dependencies."""
    resolved_settings = settings if settings is not None else load_settings()
    resolved_logger = (
        logger if logger is not None else build_service_logger(resolved_settings.log_level)
    )

    app = FastAPI(
        title="MM AI Service",
        description="Private model-agnostic AI service boundary",
        version="0.2.0",
        docs_url=None,
        redoc_url=None,
        lifespan=application_lifespan(tuple(resources), resolved_logger),
    )
    app.add_middleware(RequestContextMiddleware, logger=resolved_logger)
    register_error_handlers(app, resolved_logger)
    app.include_router(create_operations_router(resolved_settings))
    return app
