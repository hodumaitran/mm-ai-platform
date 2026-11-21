from typing import Protocol


class ManagedResource(Protocol):
    """Minimal lifecycle contract for resources actually used by an application."""

    async def start(self) -> None: ...

    async def stop(self) -> None: ...
