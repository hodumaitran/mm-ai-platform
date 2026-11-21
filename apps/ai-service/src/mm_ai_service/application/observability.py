from collections.abc import Mapping
from typing import Protocol


class EventLogger(Protocol):
    """Application-facing port for safe structured operational events."""

    def event(
        self,
        level: int,
        name: str,
        *,
        request_id: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> None: ...
