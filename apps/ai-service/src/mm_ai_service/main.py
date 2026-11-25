"""AI service composition root.

Only this module wires concrete infrastructure and presentation concerns together.
"""

from collections.abc import Sequence

from fastapi import FastAPI

from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.lifecycle import ManagedResource
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.application.prompts import PromptService
from mm_ai_service.application.providers import LLMProvider
from mm_ai_service.application.readiness import ReadinessProbe
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.config import Settings, load_settings
from mm_ai_service.domain.llm import GenerationOptions
from mm_ai_service.infrastructure.lifecycle import application_lifespan
from mm_ai_service.infrastructure.logging import build_service_logger
from mm_ai_service.infrastructure.ollama import OllamaProvider
from mm_ai_service.infrastructure.prompts import build_builtin_prompt_registry
from mm_ai_service.presentation.errors import register_error_handlers
from mm_ai_service.presentation.middleware import RequestContextMiddleware
from mm_ai_service.presentation.routes import create_operations_router


def create_app(
    settings: Settings | None = None,
    *,
    resources: Sequence[ManagedResource] = (),
    providers: Sequence[LLMProvider] = (),
    readiness_probe: ReadinessProbe | None = None,
    logger: EventLogger | None = None,
) -> FastAPI:
    """Build an isolated application instance from explicit dependencies."""
    resolved_settings = settings if settings is not None else load_settings()
    resolved_logger = (
        logger if logger is not None else build_service_logger(resolved_settings.log_level)
    )
    resolved_providers = tuple(providers)
    resolved_resources = tuple(resources)
    resolved_readiness_probe = readiness_probe
    if resolved_settings.llm_provider == "ollama" and not resolved_providers:
        ollama = OllamaProvider(
            base_url=resolved_settings.ollama_base_url,
            model=resolved_settings.ollama_model,
            context_window=resolved_settings.llm_default_context_window,
            connect_timeout_seconds=resolved_settings.ollama_connect_timeout_seconds,
            read_timeout_seconds=resolved_settings.ollama_read_timeout_seconds,
            readiness_timeout_seconds=resolved_settings.ollama_readiness_timeout_seconds,
            readiness_cache_seconds=resolved_settings.ollama_readiness_cache_seconds,
        )
        resolved_providers = (ollama,)
        resolved_resources = (*resolved_resources, ollama)
        if resolved_readiness_probe is None:
            resolved_readiness_probe = ollama
    registry = ProviderRegistry(resolved_providers, resolved_settings.llm_provider)
    gateway = LLMGateway(
        registry,
        GatewayPolicy(
            max_concurrency=resolved_settings.llm_max_concurrency,
            max_pending_requests=resolved_settings.llm_max_pending_requests,
            admission_timeout_seconds=resolved_settings.llm_admission_timeout_seconds,
            first_token_timeout_seconds=resolved_settings.llm_first_token_timeout_seconds,
            stream_inactivity_timeout_seconds=(
                resolved_settings.llm_stream_inactivity_timeout_seconds
            ),
            request_timeout_seconds=resolved_settings.llm_request_timeout_seconds,
            generation_defaults=GenerationOptions(
                temperature=resolved_settings.llm_default_temperature,
                max_output_tokens=resolved_settings.llm_default_max_output_tokens,
                context_window=resolved_settings.llm_default_context_window,
            ),
        ),
        logger=resolved_logger,
    )
    prompt_service = PromptService(
        build_builtin_prompt_registry(),
        gateway,
        resolved_settings.ollama_model,
        logger=resolved_logger,
    )

    app = FastAPI(
        title="MM AI Service",
        description="Private model-agnostic AI service boundary",
        version="0.3.0",
        docs_url=None,
        redoc_url=None,
        lifespan=application_lifespan(resolved_resources, resolved_logger),
    )
    app.add_middleware(RequestContextMiddleware, logger=resolved_logger)
    app.state.prompt_service = prompt_service
    register_error_handlers(app, resolved_logger)
    app.include_router(
        create_operations_router(
            resolved_settings,
            gateway,
            resolved_readiness_probe,
            resolved_logger,
        )
    )
    return app
