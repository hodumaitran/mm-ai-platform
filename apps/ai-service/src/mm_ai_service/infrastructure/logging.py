import json
import logging
import sys
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, TextIO

from mm_ai_service.application.observability import EventLogger

SERVICE_NAME = "ai-service"
SAFE_METADATA_KEYS = frozenset(
    {
        "duration_ms",
        "admission_outcome",
        "completion_tokens",
        "context_items",
        "context_limit",
        "error_code",
        "exception_type",
        "method",
        "path",
        "outcome",
        "history_turns_excluded",
        "history_turns_included",
        "prompt_identifier",
        "prompt_tokens",
        "prompt_version",
        "provider_identifier",
        "reference_items_excluded",
        "reference_items_included",
        "resource",
        "route",
        "status_code",
        "time_to_first_content_ms",
        "timeout_category",
    }
)


class JsonFormatter(logging.Formatter):
    """Render a stable JSON event without interpolating arbitrary exception content."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "severity": record.levelname,
            "service": SERVICE_NAME,
            "event": getattr(record, "event", "log.event"),
            "request_id": getattr(record, "request_id", None),
        }
        payload.update(getattr(record, "safe_metadata", {}))
        return json.dumps(payload, separators=(",", ":"), sort_keys=True)


class StructuredEventLogger(EventLogger):
    def __init__(self, logger: logging.Logger) -> None:
        self._logger = logger

    def event(
        self,
        level: int,
        name: str,
        *,
        request_id: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> None:
        """Emit an event while dropping fields outside the safety allowlist."""
        safe_metadata = {
            key: value
            for key, value in (metadata or {}).items()
            if key in SAFE_METADATA_KEYS and isinstance(value, (str, int, float, bool, type(None)))
        }
        self._logger.log(
            level,
            name,
            extra={"event": name, "request_id": request_id, "safe_metadata": safe_metadata},
        )


def build_service_logger(level: str, stream: TextIO | None = None) -> EventLogger:
    """Build an independent structured logger for one application instance."""
    logger = logging.Logger(SERVICE_NAME, level=level)
    handler = logging.StreamHandler(stream if stream is not None else sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False
    return StructuredEventLogger(logger)
