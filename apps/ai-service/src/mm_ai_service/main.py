from typing import Literal

from fastapi import FastAPI

from mm_ai_service.config import get_settings
from mm_ai_service.errors import unhandled_exception_handler

settings = get_settings()

app = FastAPI(
    title="MM AI Service",
    description="Private model-agnostic AI service boundary",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
)
app.add_exception_handler(Exception, unhandled_exception_handler)


@app.get("/health", tags=["operations"])
async def health() -> dict[str, Literal["ai-service", "ok"]]:
    """Report process liveness only."""
    return {"service": "ai-service", "status": "ok"}


@app.get("/ready", tags=["operations"])
async def ready() -> dict[str, object]:
    """Report readiness only for capabilities implemented in this checkpoint."""
    return {
        "service": "ai-service",
        "status": "ready",
        "capabilities": {"configuration": True, "ollama": False, "inference": False},
        "environment": settings.env,
    }
