import uvicorn

from mm_ai_service.config import load_settings


def run() -> None:
    """Start Uvicorn with its application factory and validated process settings."""
    settings = load_settings()
    uvicorn.run(
        "mm_ai_service.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    run()
