from typing import Literal

from fastapi import APIRouter

from mm_ai_service.application.readiness import Readiness, describe_readiness
from mm_ai_service.config import Settings


def create_operations_router(settings: Settings) -> APIRouter:
    router = APIRouter(tags=["operations"])

    @router.get("/health")
    async def health() -> dict[str, Literal["ai-service", "ok"]]:
        """Report process liveness only."""
        return {"service": "ai-service", "status": "ok"}

    @router.get("/ready")
    async def ready() -> Readiness:
        """Report only capabilities implemented in this checkpoint."""
        return describe_readiness(settings.env)

    return router
