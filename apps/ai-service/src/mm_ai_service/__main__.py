import uvicorn

from mm_ai_service.main import app, settings


def run() -> None:
    """Start the service from validated application settings."""
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    run()
