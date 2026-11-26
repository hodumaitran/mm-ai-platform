"""Sealed tool registry and application-owned bounded execution.

Trust model: tool calls come from a model and are untrusted. Which tools may run is decided only by
``ToolExecutionPolicy.allowed_tools`` (empty by default, so everything is denied). This is a
deployment allowlist, not authenticated RBAC and not tenant authorization.

Resource model: one request deadline (``RequestDeadline``) covers the whole call, a per-tool timeout
caps the handler, and concurrency is bounded without any queue: when capacity is full the call is
rejected, never parked. Handlers are coroutines; a handler that blocks the event loop synchronously
cannot be interrupted, so overrun is detected after it returns and its result is discarded.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType

from mm_ai_service.application.deadline import Clock, RequestDeadline, validate_timeout_seconds
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.domain.errors import (
    DuplicateToolRegistrationError,
    InvalidToolCallError,
    InvalidToolPolicyError,
    RequestDeadlineExceededError,
    ServiceError,
    ToolExecutionError,
    ToolNotAuthorizedError,
    ToolOverloadError,
    ToolRegistrySealedError,
    ToolTimeoutError,
    UnknownToolError,
)
from mm_ai_service.domain.tools import (
    MAX_RESULT_CHARS_LIMIT,
    TOOL_NAME_PATTERN,
    JsonScalar,
    ToolCall,
    ToolDefinition,
    ToolExecutionMetadata,
    ToolOutcome,
    ToolResult,
    serialize_result,
)

ToolHandler = Callable[[Mapping[str, JsonScalar]], Awaitable[object]]


@dataclass(frozen=True, slots=True)
class RegisteredTool:
    definition: ToolDefinition
    handler: ToolHandler


class ToolRegistry:
    """Startup-mutable, then sealed, in-memory registry of trusted tool handlers.

    There is no runtime registration path and no dynamic import: handlers are ordinary callables
    supplied by trusted application code before ``seal()``.
    """

    def __init__(self) -> None:
        self._tools: Mapping[str, RegisteredTool] = MappingProxyType({})
        self._sealed = False

    @property
    def is_sealed(self) -> bool:
        return self._sealed

    def register(self, definition: ToolDefinition, handler: ToolHandler) -> None:
        if self._sealed:
            raise ToolRegistrySealedError()
        if not isinstance(definition, ToolDefinition) or not callable(handler):
            raise InvalidToolPolicyError()
        if definition.name in self._tools:
            raise DuplicateToolRegistrationError()
        tools = dict(self._tools)
        tools[definition.name] = RegisteredTool(definition, handler)
        self._tools = MappingProxyType(tools)

    def seal(self) -> None:
        self._sealed = True

    def get(self, name: str) -> RegisteredTool | None:
        return self._tools.get(name)

    @property
    def names(self) -> frozenset[str]:
        return frozenset(self._tools)

    @property
    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(tool.definition for tool in self._tools.values())


@dataclass(frozen=True, slots=True)
class ToolExecutionPolicy:
    """Trusted, application-owned limits. ``allowed_tools`` defaults to empty (deny everything)."""

    allowed_tools: frozenset[str] = frozenset()
    max_concurrency: int = 2
    tool_timeout_seconds: float = 5.0
    request_timeout_seconds: float = 30.0
    max_result_chars: int = 4096

    def __post_init__(self) -> None:
        if (
            not isinstance(self.allowed_tools, frozenset)
            or any(
                not isinstance(name, str) or TOOL_NAME_PATTERN.fullmatch(name) is None
                for name in self.allowed_tools
            )
            or isinstance(self.max_concurrency, bool)
            or not isinstance(self.max_concurrency, int)
            or not 1 <= self.max_concurrency <= 64
            or not _is_valid_timeout(self.tool_timeout_seconds)
            or not _is_valid_timeout(self.request_timeout_seconds)
            or self.tool_timeout_seconds > self.request_timeout_seconds
            or isinstance(self.max_result_chars, bool)
            or not isinstance(self.max_result_chars, int)
            or not 1 <= self.max_result_chars <= MAX_RESULT_CHARS_LIMIT
        ):
            raise InvalidToolPolicyError()


def _is_valid_timeout(value: object) -> bool:
    try:
        validate_timeout_seconds(value)
    except RequestDeadlineExceededError:
        return False
    return True


@dataclass(frozen=True, slots=True)
class ToolExecution:
    result: ToolResult
    metadata: ToolExecutionMetadata


def failed_result(call: ToolCall, error: ServiceError) -> ToolResult:
    """Sanitized FAILED result for feeding a rejection back later; carries only the typed code."""
    return ToolResult(call.call_id, call.tool_name, ToolOutcome.FAILED, error_code=error.code)


class ToolExecutor:
    """Execute one authorized, validated tool call within a single request budget."""

    def __init__(
        self,
        registry: ToolRegistry,
        policy: ToolExecutionPolicy,
        *,
        logger: EventLogger | None = None,
        clock: Clock = time.monotonic,
    ) -> None:
        if (
            not registry.is_sealed
            or not isinstance(policy, ToolExecutionPolicy)
            or not policy.allowed_tools <= registry.names
        ):
            raise InvalidToolPolicyError()
        self._registry = registry
        self._policy = policy
        self._logger = logger
        self._clock = clock
        self._active = 0

    @property
    def active_executions(self) -> int:
        return self._active

    @property
    def authorized_definitions(self) -> tuple[ToolDefinition, ...]:
        """Definitions the application may offer a model: registered and on the allowlist."""
        return tuple(
            definition
            for definition in self._registry.definitions
            if definition.name in self._policy.allowed_tools
        )

    async def execute(
        self,
        call: ToolCall,
        *,
        timeout_seconds: float | None = None,
        deadline: RequestDeadline | None = None,
    ) -> ToolExecution:
        """Run ``call`` or raise a typed, sanitized ``ServiceError``.

        Pass an existing ``deadline`` to continue a request budget; otherwise a new one is started
        from ``timeout_seconds`` capped at the policy maximum. Never both.
        """
        if not isinstance(call, ToolCall):
            raise InvalidToolCallError()
        if deadline is not None and timeout_seconds is not None:
            raise InvalidToolCallError()
        if deadline is None:
            requested = (
                self._policy.request_timeout_seconds
                if timeout_seconds is None
                else validate_timeout_seconds(timeout_seconds)
            )
            deadline = RequestDeadline(
                min(requested, self._policy.request_timeout_seconds), self._clock
            )
        deadline.remaining()  # expired budgets never reach validation or a handler

        registered = self._registry.get(call.tool_name)
        if registered is None:
            raise UnknownToolError()
        name = registered.definition.name
        if name not in self._policy.allowed_tools:
            raise ToolNotAuthorizedError()
        try:
            arguments = registered.definition.validate_arguments(call.arguments)
        except ServiceError as error:
            self._event(logging.WARNING, "tool.execution_rejected", name, error.code)
            raise

        started = self._clock()
        self._event(logging.INFO, "tool.execution_started", name)
        try:
            content = await self._run(registered, arguments, deadline, started)
        except asyncio.CancelledError:
            self._event(logging.INFO, "tool.execution_cancelled", name)
            raise
        except ServiceError as error:
            self._event(logging.WARNING, "tool.execution_failed", name, error.code)
            raise
        result = ToolResult(call.call_id, name, ToolOutcome.SUCCEEDED, content)
        metadata = ToolExecutionMetadata(
            tool_name=name,
            outcome=ToolOutcome.SUCCEEDED,
            duration_ms=max(0, round((self._clock() - started) * 1000)),
            argument_count=len(arguments),
            result_chars=len(content),
        )
        self._event(logging.INFO, "tool.execution_finished", name, None, metadata)
        return ToolExecution(result, metadata)

    async def _run(
        self,
        registered: RegisteredTool,
        arguments: Mapping[str, JsonScalar],
        deadline: RequestDeadline,
        started: float,
    ) -> str:
        budget = deadline.remaining()  # re-checked: validation may have consumed budget
        tool_limit = self._policy.tool_timeout_seconds
        deadline_governs = budget <= tool_limit
        if self._active >= self._policy.max_concurrency:
            raise ToolOverloadError()
        self._active += 1
        try:
            try:
                async with asyncio.timeout(min(budget, tool_limit)) as scope:
                    value = await registered.handler(arguments)
            except TimeoutError:
                if not scope.expired():
                    raise ToolExecutionError() from None
                raise self._timeout_error(deadline_governs) from None
            except ServiceError:
                raise
            except Exception:
                raise ToolExecutionError() from None
        finally:
            self._active -= 1
        # A handler that blocked synchronously cannot be preempted; detect the overrun now and
        # discard its result rather than returning data produced after the budget ended.
        if self._clock() - started > tool_limit:
            raise self._timeout_error(deadline_governs)
        deadline.remaining()
        return serialize_result(value, self._policy.max_result_chars)

    @staticmethod
    def _timeout_error(deadline_governs: bool) -> ServiceError:
        return RequestDeadlineExceededError() if deadline_governs else ToolTimeoutError()

    def _event(
        self,
        level: int,
        name: str,
        tool_name: str,
        error_code: str | None = None,
        metadata: ToolExecutionMetadata | None = None,
    ) -> None:
        if self._logger is None:
            return
        fields: dict[str, object] = {"tool_name": tool_name}
        if error_code is not None:
            fields["error_code"] = error_code
        if metadata is not None:
            fields.update(
                outcome=metadata.outcome.value,
                duration_ms=metadata.duration_ms,
                argument_count=metadata.argument_count,
                result_chars=metadata.result_chars,
            )
        self._logger.event(level, name, metadata=fields)
