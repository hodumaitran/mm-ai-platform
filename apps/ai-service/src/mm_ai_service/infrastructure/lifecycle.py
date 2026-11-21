import logging
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI

from mm_ai_service.application.lifecycle import ManagedResource
from mm_ai_service.application.observability import EventLogger

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def application_lifespan(resources: Sequence[ManagedResource], logger: EventLogger) -> Lifespan:
    """Create deterministic startup, rollback, and reverse-order shutdown behavior."""

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        started: list[ManagedResource] = []
        try:
            for resource in resources:
                await resource.start()
                started.append(resource)
            logger.event(logging.INFO, "service.started")
            yield
        except BaseException:
            await _stop_resources(started, logger, suppress_errors=True)
            raise
        else:
            await _stop_resources(started, logger, suppress_errors=False)
            logger.event(logging.INFO, "service.stopped")

    return lifespan


async def _stop_resources(
    resources: Sequence[ManagedResource],
    logger: EventLogger,
    *,
    suppress_errors: bool,
) -> None:
    failures: list[BaseException] = []
    for resource in reversed(resources):
        try:
            await resource.stop()
        except BaseException as error:
            failures.append(error)
            logger.event(
                logging.ERROR,
                "resource.stop_failed",
                metadata={"resource": type(resource).__name__},
            )
    if failures and not suppress_errors:
        raise BaseExceptionGroup("Resource shutdown failed", failures)
