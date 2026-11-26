"""Monotonic request-budget accounting shared by services that prepare work before the gateway.

The gateway owns the authoritative deadline policy (caller timeout capped by its maximum). A service
that does synchronous preparation first must start the clock *before* that work and hand only the
remaining budget to the gateway, otherwise preparation time would sit outside the deadline.

This is accounting, not preemption: synchronous preparation cannot be interrupted by asyncio, so an
exhausted budget is detected immediately after preparation and before any provider call.
"""

import math
import time
from collections.abc import Callable

from mm_ai_service.domain.errors import RequestDeadlineExceededError

Clock = Callable[[], float]


def validate_timeout_seconds(value: object) -> float:
    """Accept only a finite, positive, non-boolean number; reject everything else."""
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise RequestDeadlineExceededError()
    return float(value)


class RequestDeadline:
    """An absolute expiry on a monotonic clock, created from a total budget in seconds."""

    __slots__ = ("_clock", "_expires_at")

    def __init__(self, total_seconds: float, clock: Clock = time.monotonic) -> None:
        self._clock = clock
        self._expires_at = clock() + total_seconds

    def remaining(self) -> float:
        """Seconds left, or raise the standard deadline error once the budget is exhausted."""
        left = self._expires_at - self._clock()
        if left <= 0:
            raise RequestDeadlineExceededError()
        return left
