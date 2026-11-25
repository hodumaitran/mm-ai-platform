from typing import Literal

from fastapi import APIRouter

from mm_ai_service.application.gateway import LLMGateway
from mm_ai_service.application.readiness import (
    ProviderReadiness,
    Readiness,
    ReadinessProbe,
    describe_readiness,
)
from mm_ai_service.config import Settings


def create_operations_router(
    settings: Settings,
    gateway: LLMGateway,
    readiness_probe: ReadinessProbe | None = None,
) -> APIRouter:
    router = APIRouter(tags=["operations"])

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

    return router
