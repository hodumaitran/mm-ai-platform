"""Bounded, sequential tool-calling orchestration over the existing services.

Flow: prepare context once, offer only authorized tool definitions, validate model requests,
execute sequentially under one request deadline, return bounded untrusted results, and generate the
final answer. There are no retries, no recursion and no background tasks; the loop is capped by
``max_rounds`` tool rounds (plus one final tool-free generation) and ``max_calls`` total calls.

Each gateway call releases its admission slot before any tool runs, because the gateway context
exits when ``complete`` returns. Tool-enabled streaming is deliberately not provided.
"""

import json
import logging
from dataclasses import dataclass, replace

from mm_ai_service.application.context import ContextService
from mm_ai_service.application.deadline import RequestDeadline
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.application.tools import ToolExecutor
from mm_ai_service.domain.context import ContextAssemblyResult, ContextBudget, ContextInvocation
from mm_ai_service.domain.errors import (
    ContextBudgetExceededError,
    DuplicateToolCallError,
    InvalidToolArgumentsError,
    InvalidToolPolicyError,
    ServiceError,
    ToolCallLimitExceededError,
    ToolExecutionError,
    ToolResultTooLargeError,
    ToolTimeoutError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionRequest,
    CompletionResponse,
    MessageRole,
)
from mm_ai_service.domain.tools import ToolCall, ToolDefinition, ToolExecutionMetadata, ToolOutcome

# Failures of one call that the model may be told about (code only) so it can still answer.
# Request-level failures (deadline, overload, cancellation, unknown/unauthorized tool) propagate.
_FEEDBACK_ERRORS = (
    InvalidToolArgumentsError,
    ToolExecutionError,
    ToolTimeoutError,
    ToolResultTooLargeError,
)


@dataclass(frozen=True, slots=True)
class ToolOrchestrationPolicy:
    max_rounds: int = 3
    max_calls: int = 5

    def __post_init__(self) -> None:
        if (
            isinstance(self.max_rounds, bool)
            or isinstance(self.max_calls, bool)
            or not isinstance(self.max_rounds, int)
            or not isinstance(self.max_calls, int)
            or not 1 <= self.max_rounds <= 3
            or not 1 <= self.max_calls <= 5
        ):
            raise InvalidToolPolicyError()


@dataclass(frozen=True, slots=True)
class ToolOrchestrationResult:
    """Final response plus content-free evidence of every tool call that was attempted."""

    response: CompletionResponse
    executions: tuple[ToolExecutionMetadata, ...]
    rounds: int


class ToolCallingOrchestrator:
    """Internal entry point for tool-enabled completion (not exposed over HTTP)."""

    def __init__(
        self,
        context: ContextService,
        executor: ToolExecutor,
        policy: ToolOrchestrationPolicy | None = None,
        *,
        logger: EventLogger | None = None,
    ) -> None:
        self._context = context
        self._executor = executor
        self._policy = policy or ToolOrchestrationPolicy()
        self._logger = logger

    async def complete(
        self,
        invocation: ContextInvocation,
        *,
        request_id: str | None = None,
        timeout_seconds: float | None = None,
    ) -> ToolOrchestrationResult:
        prompts = self._context.prompts
        gateway = prompts.gateway
        # One authoritative budget for preparation, every model round and every tool call.
        deadline = RequestDeadline(gateway.deadline_seconds(timeout_seconds), prompts.clock)
        try:
            result = await self._run(invocation, request_id, deadline)
        except ServiceError as error:
            self._event(logging.WARNING, "tool.orchestration_failed", request_id, error.code)
            raise
        self._event(
            logging.INFO,
            "tool.orchestration_finished",
            request_id,
            None,
            {"tool_rounds": result.rounds, "tool_calls": len(result.executions)},
        )
        return result

    async def _run(
        self, invocation: ContextInvocation, request_id: str | None, deadline: RequestDeadline
    ) -> ToolOrchestrationResult:
        prepared = self._context.prepare(invocation, request_id=request_id)
        gateway = self._context.prompts.gateway
        definitions = self._executor.authorized_definitions
        messages = list(prepared.request.messages)
        used_ids: set[str] = set()
        executions: list[ToolExecutionMetadata] = []
        for round_number in range(self._policy.max_rounds + 1):
            # The last generation offers no tools, so the loop always ends with a final answer.
            offered = definitions if round_number < self._policy.max_rounds else ()
            request = replace(prepared.request, messages=tuple(messages), tools=offered)
            self._check_budget(prepared, request)
            response = await gateway.complete(request, timeout_seconds=deadline.remaining())
            calls = response.message.tool_calls
            if not calls:
                return ToolOrchestrationResult(response, tuple(executions), round_number)
            if len(executions) + len(calls) > self._policy.max_calls:
                raise ToolCallLimitExceededError()
            if any(call.call_id in used_ids for call in calls):
                raise DuplicateToolCallError()
            used_ids.update(call.call_id for call in calls)
            messages.append(response.message)
            for call in calls:
                content, metadata = await self._execute(call, deadline)
                executions.append(metadata)
                messages.append(
                    ChatMessage(
                        MessageRole.TOOL,
                        content,
                        tool_call_id=call.call_id,
                        tool_name=call.tool_name,
                    )
                )
        raise ToolCallLimitExceededError()  # unreachable: the final round offers no tools

    async def _execute(
        self, call: ToolCall, deadline: RequestDeadline
    ) -> tuple[str, ToolExecutionMetadata]:
        clock = self._context.prompts.clock
        started = clock()
        try:
            execution = await self._executor.execute(call, deadline=deadline)
        except _FEEDBACK_ERRORS as error:
            metadata = ToolExecutionMetadata(
                tool_name=call.tool_name,
                outcome=ToolOutcome.FAILED,
                duration_ms=max(0, round((clock() - started) * 1000)),
                argument_count=len(call.arguments),
                result_chars=0,
                error_code=error.code,
            )
            return json.dumps({"error": error.code}), metadata
        return execution.result.content, execution.metadata

    def _check_budget(self, prepared: ContextAssemblyResult, request: CompletionRequest) -> None:
        """Re-validate the whole request, tool schemas and tool exchanges included.

        Mandatory and prior context is never truncated here: if it no longer fits, fail.
        """
        budget: ContextBudget = prepared.budget
        texts = [
            ChatMessage(MessageRole.USER, _message_text(message)) for message in request.messages
        ]
        if request.tools:
            texts.append(ChatMessage(MessageRole.USER, _definitions_text(request.tools)))
        estimate = self._context.prompts.estimator.estimate(texts, budget.output_tokens)
        committed = estimate.prompt_tokens + budget.output_tokens + budget.safety_margin_tokens
        if committed > budget.effective_context_tokens:
            raise ContextBudgetExceededError()

    def _event(
        self,
        level: int,
        name: str,
        request_id: str | None,
        error_code: str | None = None,
        metadata: dict[str, object] | None = None,
    ) -> None:
        if self._logger is None:
            return
        fields: dict[str, object] = dict(metadata or {})
        if error_code is not None:
            fields["error_code"] = error_code
        self._logger.event(level, name, request_id=request_id, metadata=fields)


def _message_text(message: ChatMessage) -> str:
    calls = " ".join(
        f"{call.tool_name} {json.dumps(dict(call.arguments), sort_keys=True)}"
        for call in message.tool_calls
    )
    return f"{message.content} {calls}".strip()


def _definitions_text(definitions: tuple[ToolDefinition, ...]) -> str:
    return " ".join(
        f"{definition.name} {definition.description} "
        + " ".join(
            f"{parameter.name} {parameter.type.value} {parameter.description} "
            f"{parameter.allowed_values or ''}"
            for parameter in definition.parameters
        )
        for definition in definitions
    )
