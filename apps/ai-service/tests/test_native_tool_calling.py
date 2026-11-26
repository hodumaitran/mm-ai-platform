import asyncio
import io
import json
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any

import httpx
import pytest

from mm_ai_service.application.context import ContextService
from mm_ai_service.application.demo_tools import CALCULATE, TEXT_STATISTICS, build_demo_registry
from mm_ai_service.application.gateway import GatewayPolicy
from mm_ai_service.application.prompts import PromptService
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.application.tool_orchestration import (
    ToolCallingOrchestrator,
    ToolOrchestrationPolicy,
)
from mm_ai_service.application.tools import ToolExecutionPolicy, ToolExecutor, ToolRegistry
from mm_ai_service.domain.context import ContextInvocation
from mm_ai_service.domain.errors import (
    ContextBudgetExceededError,
    DuplicateToolCallError,
    InvalidCompletionRequestError,
    InvalidProviderResponseError,
    InvalidToolPolicyError,
    RequestDeadlineExceededError,
    ToolCallLimitExceededError,
    UnsupportedCapabilityError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    FinishReason,
    MessageRole,
    ModelCapabilities,
    StreamEvent,
    StreamStarted,
)
from mm_ai_service.domain.prompts import PromptIdentifier, PromptInvocation
from mm_ai_service.domain.tools import (
    JsonScalar,
    ParameterType,
    ToolCall,
    ToolDefinition,
    ToolOutcome,
    ToolParameter,
)
from mm_ai_service.infrastructure.logging import build_service_logger
from mm_ai_service.infrastructure.ollama import OllamaProvider
from mm_ai_service.main import create_app
from tests.fakes import FakeProvider, response_for
from tests.test_context_management import MODEL as TRUSTED_MODEL
from tests.test_context_management import _invocation, _registry
from tests.test_ollama_provider import MODEL, _api_response, _provider, _request
from tests.test_request_deadline import AdvancingEstimator, FakeClock, RecordingGateway

Script = Callable[[CompletionRequest], CompletionResponse]


# --- native Ollama mapping ------------------------------------------------------------------------


def _tool_request(*extra: ChatMessage) -> CompletionRequest:
    return CompletionRequest(
        MODEL,
        (ChatMessage(MessageRole.USER, "6 x 7?"), *extra),
        tools=(CALCULATE, TEXT_STATISTICS),
    )


def _native_provider(
    chat: Callable[[httpx.Request], httpx.Response], *, tools: bool = True
) -> tuple[OllamaProvider, list[dict[str, Any]]]:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/show":
            capabilities = ["completion", "tools"] if tools else ["completion"]
            return httpx.Response(
                200,
                json={"capabilities": capabilities, "model_info": {"qwen.context_length": 32768}},
            )
        api = _api_response(request)
        if api is not None:
            return api
        bodies.append(json.loads(request.content))
        return chat(request)

    return _provider(handler), bodies


def _tool_reply(*calls: Any, content: str = "", **message: Any) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "model": MODEL,
            "message": {
                "role": "assistant",
                "content": content,
                "tool_calls": list(calls),
                **message,
            },
            "done": True,
            "done_reason": "stop",
        },
    )


def _fn(name: Any, arguments: Any) -> dict[str, Any]:
    return {"function": {"name": name, "arguments": arguments}}


def test_ollama_capability_detection_reports_native_tools_accurately() -> None:
    async def scenario() -> None:
        for tools in (True, False):
            provider, _ = _native_provider(lambda r: httpx.Response(500), tools=tools)
            assert provider.capabilities.tool_calling is False  # conservative before readiness
            await provider.start()
            assert provider.capabilities.tool_calling is tools
            await provider.stop()

    asyncio.run(scenario())


def test_ollama_maps_tool_definitions_to_native_function_schema() -> None:
    async def scenario() -> list[dict[str, Any]]:
        provider, bodies = _native_provider(
            lambda r: httpx.Response(
                200,
                json={
                    "model": MODEL,
                    "message": {"role": "assistant", "content": "ok"},
                    "done": True,
                },
            )
        )
        await provider.start()
        await provider.complete(_tool_request())
        await provider.stop()
        return bodies

    body = asyncio.run(scenario())[0]
    calculate, statistics = body["tools"]
    assert calculate["type"] == "function"
    function = calculate["function"]
    assert function["name"] == "calculate"
    schema = function["parameters"]
    assert schema["type"] == "object" and schema["additionalProperties"] is False
    assert schema["required"] == ["operation", "left", "right"]
    assert schema["properties"]["operation"]["enum"] == ["add", "subtract", "multiply", "divide"]
    assert schema["properties"]["left"]["minimum"] == -1_000_000
    assert schema["properties"]["left"]["type"] == "number"
    assert statistics["function"]["parameters"]["properties"]["text"]["maxLength"] == 2000


def test_ollama_serializes_assistant_tool_calls_and_tool_results_in_order() -> None:
    call = ToolCall("call_1", "calculate", {"operation": "multiply", "left": 6, "right": 7})
    request = _tool_request(
        ChatMessage(MessageRole.ASSISTANT, "", (call,)),
        ChatMessage(
            MessageRole.TOOL, '{"result":42}', tool_call_id="call_1", tool_name="calculate"
        ),
    )

    async def scenario() -> list[dict[str, Any]]:
        provider, bodies = _native_provider(
            lambda r: httpx.Response(
                200,
                json={
                    "model": MODEL,
                    "message": {"role": "assistant", "content": "42"},
                    "done": True,
                },
            )
        )
        await provider.start()
        await provider.complete(request)
        await provider.stop()
        return bodies

    messages = asyncio.run(scenario())[0]["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "tool"]
    assert messages[1]["tool_calls"] == [
        {
            "function": {
                "name": "calculate",
                "arguments": {"operation": "multiply", "left": 6, "right": 7},
            }
        }
    ]
    assert messages[2]["tool_name"] == "calculate" and messages[2]["content"] == '{"result":42}'


def test_ollama_parses_valid_native_tool_calls_and_never_exposes_reasoning() -> None:
    async def scenario() -> CompletionResponse:
        provider, _ = _native_provider(
            lambda r: _tool_reply(
                _fn("calculate", {"operation": "add", "left": 1, "right": 2}),
                _fn("text_statistics", {"text": "hi"}),
                thinking="SECRET-REASONING",
            )
        )
        await provider.start()
        try:
            return await provider.complete(_tool_request())
        finally:
            await provider.stop()

    response = asyncio.run(scenario())
    calls = response.message.tool_calls
    assert [c.tool_name for c in calls] == ["calculate", "text_statistics"]
    assert [c.call_id for c in calls] == ["call_1", "call_2"]
    assert dict(calls[0].arguments) == {"operation": "add", "left": 1, "right": 2}
    assert response.finish_reason is FinishReason.TOOL_CALL
    assert "SECRET" not in repr(response)


@pytest.mark.parametrize(
    "calls",
    [
        [_fn("calculate", '{"operation":"add"}')],  # JSON string instead of an object
        [_fn("calculate", None)],
        [_fn(1, {})],
        [{"function": "calculate"}],
        ["calculate"],
        [_fn("calculate", {"a": {"b": {"c": {"d": {"e": 1}}}}})],  # too deep
        [_fn("Bad Name", {})],
        [_fn("calculate", {})] * 9,  # too many in one message
    ],
)
def test_ollama_rejects_malformed_tool_calls(calls: list[Any]) -> None:
    async def scenario() -> None:
        provider, _ = _native_provider(lambda r: _tool_reply(*calls))
        await provider.start()
        try:
            await provider.complete(_tool_request())
        finally:
            await provider.stop()

    with pytest.raises(InvalidProviderResponseError):
        asyncio.run(scenario())


def test_ollama_rejects_non_list_tool_calls_and_empty_message_without_calls() -> None:
    for message in (
        {"role": "assistant", "content": "x", "tool_calls": "calculate"},
        {"role": "assistant", "content": ""},
    ):

        async def scenario(message: dict[str, Any] = message) -> None:
            provider, _ = _native_provider(
                lambda r: httpx.Response(
                    200, json={"model": MODEL, "message": message, "done": True}
                )
            )
            await provider.start()
            try:
                await provider.complete(_tool_request())
            finally:
                await provider.stop()

        with pytest.raises(InvalidProviderResponseError):
            asyncio.run(scenario())


def test_ordinary_requests_have_no_tool_fields_and_streaming_rejects_tools() -> None:
    async def scenario() -> dict[str, Any]:
        provider, bodies = _native_provider(
            lambda r: httpx.Response(
                200,
                json={
                    "model": MODEL,
                    "message": {"role": "assistant", "content": "ok"},
                    "done": True,
                },
            )
        )
        await provider.start()
        await provider.complete(_request())
        with pytest.raises(UnsupportedCapabilityError):
            async for _ in provider.stream(_tool_request()):
                pass
        await provider.stop()
        return bodies[0]

    body = asyncio.run(scenario())
    assert "tools" not in body
    assert body["messages"][0] == {"role": "system", "content": "Be concise."}


# --- domain contracts -----------------------------------------------------------------------------


def test_chat_message_tool_field_rules() -> None:
    call = ToolCall("call_1", "calculate", {})
    assert ChatMessage(MessageRole.ASSISTANT, "", (call,)).tool_calls == (call,)
    for build in (
        lambda: ChatMessage(MessageRole.ASSISTANT, ""),  # empty without calls
        lambda: ChatMessage(MessageRole.USER, "x", (call,)),  # calls only on assistant
        lambda: ChatMessage(MessageRole.TOOL, "x"),  # tool result must name its call
        lambda: ChatMessage(MessageRole.TOOL, "x", tool_call_id="bad id", tool_name="calculate"),
        lambda: ChatMessage(MessageRole.USER, "x", tool_call_id="c1"),
        lambda: ChatMessage(MessageRole.ASSISTANT, "x", tuple([call] * 9)),
        lambda: ChatMessage(MessageRole.ASSISTANT, "x", ("call",)),  # type: ignore[arg-type]
    ):
        with pytest.raises(InvalidCompletionRequestError):
            build()  # type: ignore[no-untyped-call]


def test_completion_request_and_response_tool_rules() -> None:
    message = (ChatMessage(MessageRole.USER, "hi"),)
    with pytest.raises(InvalidCompletionRequestError):
        CompletionRequest("m", message, tools=(CALCULATE, CALCULATE))
    with pytest.raises(InvalidCompletionRequestError):
        CompletionRequest("m", message, tools=("calculate",))  # type: ignore[arg-type]
    call = ToolCall("call_1", "calculate", {})
    with pytest.raises(InvalidCompletionRequestError):  # calls require the tool_call finish reason
        CompletionResponse("m", ChatMessage(MessageRole.ASSISTANT, "", (call,)), FinishReason.STOP)
    with pytest.raises(InvalidCompletionRequestError):
        CompletionResponse("m", ChatMessage(MessageRole.ASSISTANT, "x"), FinishReason.TOOL_CALL)


# --- orchestrator harness -------------------------------------------------------------------------


def _calls(*calls: tuple[str, str, dict[str, Any]]) -> Script:
    def script(request: CompletionRequest) -> CompletionResponse:
        return CompletionResponse(
            request.model_identifier,
            ChatMessage(
                MessageRole.ASSISTANT,
                "",
                tuple(ToolCall(call_id, name, args) for call_id, name, args in calls),
            ),
            FinishReason.TOOL_CALL,
        )

    return script


def _final(text: str = "final answer") -> Script:
    return lambda request: response_for(request, content=text)


def _add(call_id: str = "call_1", left: int = 2, right: int = 3) -> Script:
    return _calls((call_id, "calculate", {"operation": "add", "left": left, "right": right}))


class Stack:
    def __init__(
        self,
        script: list[Script],
        *,
        registry: ToolRegistry | None = None,
        allowed: frozenset[str] | None = None,
        tool_calling: bool = True,
        context_tokens: int = 4000,
        policy: ToolOrchestrationPolicy | None = None,
        logger: Any = None,
        concurrency: int = 1,
        pending: int = 0,
        advance_per_model_call: float = 0.0,
        gateway_timeout: float = 300.0,
        executor_policy: dict[str, Any] | None = None,
    ) -> None:
        self.clock = FakeClock()
        self.requests: list[CompletionRequest] = []
        self.script = list(script)
        self.hold: asyncio.Event | None = None

        async def complete(request: CompletionRequest) -> CompletionResponse:
            self.requests.append(request)
            self.clock.now += advance_per_model_call
            if self.hold is not None:
                await self.hold.wait()
            return self.script[len(self.requests) - 1](request)

        async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
            yield StreamStarted(request.model_identifier)
            yield ContentDelta("plain")
            yield CompletionFinished(FinishReason.STOP)

        provider = FakeProvider(
            complete,
            stream,
            capabilities=ModelCapabilities(
                streaming=True, tool_calling=tool_calling, max_context_tokens=8192
            ),
        )
        self.gateway = RecordingGateway(
            ProviderRegistry((provider,), provider.provider_id),
            GatewayPolicy(
                max_concurrency=concurrency,
                max_pending_requests=pending,
                request_timeout_seconds=gateway_timeout,
            ),
            logger,
        )
        self.prompts = PromptService(
            _registry(context_tokens=context_tokens),
            self.gateway,
            TRUSTED_MODEL,
            estimator=AdvancingEstimator(self.clock, 0.0),
            clock=self.clock,
            logger=logger,
        )
        self.context = ContextService(self.prompts, logger=logger)
        self.tools = registry or build_demo_registry()
        self.executor = ToolExecutor(
            self.tools,
            ToolExecutionPolicy(
                allowed_tools=self.tools.names if allowed is None else allowed,
                **(executor_policy or {}),
            ),
            logger=logger,
            clock=self.clock,
        )
        self.orchestrator = ToolCallingOrchestrator(
            self.context, self.executor, policy, logger=logger
        )

    def run(self, text: str = "compute", **kwargs: Any) -> Any:
        return asyncio.run(self.orchestrator.complete(_invocation(text), **kwargs))


def _tool_contents(request: CompletionRequest) -> list[ChatMessage]:
    return [m for m in request.messages if m.role is MessageRole.TOOL]


# --- orchestration: success paths -----------------------------------------------------------------


def test_valid_native_tool_call_executes_and_final_response_follows() -> None:
    stack = Stack([_add(), _final("The sum is 5")])
    result = stack.run("add numbers")
    assert result.response.message.content == "The sum is 5"
    assert result.rounds == 1 and len(result.executions) == 1
    execution = result.executions[0]
    assert execution.tool_name == "calculate" and execution.outcome is ToolOutcome.SUCCEEDED
    first, second = stack.requests
    assert {t.name for t in first.tools} == {"calculate", "text_statistics"}
    tail = second.messages[-2:]
    assert tail[0].role is MessageRole.ASSISTANT and tail[0].tool_calls[0].call_id == "call_1"
    assert tail[1].role is MessageRole.TOOL and tail[1].tool_call_id == "call_1"
    assert json.loads(tail[1].content) == {"operation": "add", "result": 5}
    assert second.messages[:-2] == first.messages  # prior context preserved, order intact


def test_plain_request_without_tool_use_completes_in_one_call() -> None:
    stack = Stack([_final("hello")])
    result = stack.run("just chat")
    assert result.rounds == 0 and result.executions == () and len(stack.requests) == 1


def test_multiple_calls_in_one_round_run_sequentially_in_order() -> None:
    stack = Stack(
        [
            _calls(
                ("call_1", "calculate", {"operation": "add", "left": 1, "right": 1}),
                ("call_2", "text_statistics", {"text": "a b"}),
            ),
            _final(),
        ]
    )
    result = stack.run()
    assert [e.tool_name for e in result.executions] == ["calculate", "text_statistics"]
    tools = _tool_contents(stack.requests[1])
    assert [m.tool_call_id for m in tools] == ["call_1", "call_2"]


# --- orchestration: rejection and limits ---------------------------------------------------------


def test_unsupported_provider_capability_never_calls_the_provider() -> None:
    stack = Stack([_final()], tool_calling=False)
    with pytest.raises(UnsupportedCapabilityError):
        stack.run()
    assert stack.requests == []


def test_unknown_tool_from_model_is_rejected_and_nothing_executes() -> None:
    stack = Stack([_calls(("call_1", "delete_everything", {}))])
    with pytest.raises(InvalidProviderResponseError):
        stack.run()
    assert stack.executor.active_executions == 0 and len(stack.requests) == 1


def test_unauthorized_tool_is_neither_offered_nor_executable() -> None:
    stack = Stack(
        [_add()],
        allowed=frozenset({"text_statistics"}),
    )
    with pytest.raises(InvalidProviderResponseError):
        stack.run()
    assert [t.name for t in stack.requests[0].tools] == ["text_statistics"]


def test_empty_allowlist_offers_no_tools_and_denies_tool_calls() -> None:
    stack = Stack([_add()], allowed=frozenset())
    assert stack.executor.authorized_definitions == ()
    with pytest.raises(InvalidProviderResponseError):
        stack.run()
    assert stack.requests[0].tools == ()


def test_malformed_arguments_are_fed_back_as_a_sanitized_failure() -> None:
    stack = Stack(
        [
            _calls(("call_1", "calculate", {"operation": "add", "left": "SECRET", "right": 1})),
            _final(),
        ]
    )
    result = stack.run()
    assert result.executions[0].outcome is ToolOutcome.FAILED
    assert result.executions[0].error_code == "INVALID_TOOL_ARGUMENTS"
    message = _tool_contents(stack.requests[1])[0]
    assert json.loads(message.content) == {"error": "INVALID_TOOL_ARGUMENTS"}
    assert "SECRET" not in message.content


def test_handler_failure_is_fed_back_without_exception_text() -> None:
    stack = Stack(
        [_calls(("call_1", "calculate", {"operation": "divide", "left": 1, "right": 0})), _final()]
    )
    result = stack.run()
    assert result.executions[0].error_code == "TOOL_EXECUTION_FAILED"
    assert "division" not in _tool_contents(stack.requests[1])[0].content.lower()


def test_oversized_tool_result_is_rejected_and_reported_as_failure() -> None:
    async def big(arguments: Mapping[str, JsonScalar]) -> object:
        return "y" * 500

    registry = ToolRegistry()
    registry.register(ToolDefinition("big", "Big result."), big)
    registry.seal()
    stack = Stack(
        [_calls(("call_1", "big", {})), _final()],
        registry=registry,
        executor_policy={"max_result_chars": 100},
    )
    assert stack.run().executions[0].error_code == "TOOL_RESULT_TOO_LARGE"


def test_duplicate_call_identifiers_are_rejected() -> None:
    stack = Stack([_add("call_1"), _add("call_1")])
    with pytest.raises(DuplicateToolCallError):
        stack.run()
    assert len(stack.requests) == 2  # the first call ran; the repeat never executed

    within = Stack(
        [
            _calls(
                ("call_1", "calculate", {"operation": "add", "left": 1, "right": 1}),
                ("call_1", "calculate", {"operation": "add", "left": 1, "right": 1}),
            )
        ]
    )
    with pytest.raises(InvalidProviderResponseError):
        within.run()


def test_rounds_are_bounded_and_the_last_generation_offers_no_tools() -> None:
    stack = Stack([_add("call_1"), _add("call_2"), _add("call_3"), _add("call_4")])
    with pytest.raises(InvalidProviderResponseError):  # model keeps asking: not offered any more
        stack.run()
    assert len(stack.requests) == 4
    assert [bool(r.tools) for r in stack.requests] == [True, True, True, False]

    final = Stack([_add("call_1"), _add("call_2"), _add("call_3"), _final("done")])
    result = final.run()
    assert result.rounds == 3 and len(result.executions) == 3
    assert result.response.message.content == "done"


def test_total_call_limit_is_enforced_before_extra_calls_run() -> None:
    three = tuple(
        (f"call_{i}", "calculate", {"operation": "add", "left": i, "right": 1}) for i in (1, 2, 3)
    )
    more = tuple(
        (f"call_{i}", "calculate", {"operation": "add", "left": i, "right": 1}) for i in (4, 5, 6)
    )
    stack = Stack([_calls(*three), _calls(*more)])
    with pytest.raises(ToolCallLimitExceededError):
        stack.run()
    assert len(stack.requests) == 2  # exactly three calls ran, the next batch did not


def test_orchestration_policy_validation() -> None:
    for kwargs in ({"max_rounds": 0}, {"max_rounds": 4}, {"max_calls": 6}, {"max_calls": True}):
        with pytest.raises(InvalidToolPolicyError):
            ToolOrchestrationPolicy(**kwargs)


# --- budgets and deadline -------------------------------------------------------------------------


def test_budget_is_revalidated_for_tool_schemas_and_never_truncates() -> None:
    # Tool schemas alone no longer fit: fail before the provider is called.
    tiny = Stack([_final()], context_tokens=250)
    with pytest.raises(ContextBudgetExceededError):
        tiny.run()
    assert tiny.requests == []


def test_budget_exhaustion_after_tool_results_stops_before_the_next_model_call() -> None:
    async def verbose(arguments: Mapping[str, JsonScalar]) -> object:
        return "z" * 900

    registry = ToolRegistry()
    registry.register(ToolDefinition("verbose", "Long output."), verbose)
    registry.seal()
    stack = Stack(
        [_calls(("call_1", "verbose", {})), _final()],
        registry=registry,
        context_tokens=700,
        executor_policy={"max_result_chars": 2000},
    )
    with pytest.raises(ContextBudgetExceededError):
        stack.run()
    assert len(stack.requests) == 1  # the grown context was never sent


def test_one_deadline_spans_all_rounds_and_tools() -> None:
    stack = Stack([_add("call_1"), _add("call_2"), _final()], advance_per_model_call=0.6)
    with pytest.raises(RequestDeadlineExceededError):
        stack.run(timeout_seconds=1.0)
    received = stack.gateway.received
    assert received[0] == pytest.approx(1.0) and received[1] == pytest.approx(0.4)
    assert len(stack.requests) == 2  # no third model call and no tool run after expiry


def test_invalid_timeouts_are_rejected_before_any_work() -> None:
    for bad in (0, -1, float("nan"), float("inf"), True):
        stack = Stack([_final()])
        with pytest.raises(RequestDeadlineExceededError):
            stack.run(timeout_seconds=bad)
        assert stack.requests == []


# --- cancellation, capacity, isolation ------------------------------------------------------------


def test_gateway_capacity_is_released_before_tools_run() -> None:
    async def scenario() -> str:
        stack = Stack([], concurrency=1, pending=0)
        seen: list[str] = []

        async def nested(arguments: Mapping[str, JsonScalar]) -> object:
            # Gateway has a single slot and no queue: this only works if the slot is free now.
            plain = await stack.gateway.complete(
                CompletionRequest(TRUSTED_MODEL, (ChatMessage(MessageRole.USER, "x"),))
            )
            seen.append(plain.message.content)
            return {"ok": True}

        registry = ToolRegistry()
        registry.register(ToolDefinition("probe", "Probe."), nested)
        registry.seal()
        stack.__init__(  # type: ignore[misc]
            [_calls(("call_1", "probe", {})), _final("nested"), _final("outer")],
            registry=registry,
            concurrency=1,
            pending=0,
        )
        await stack.orchestrator.complete(_invocation("go"))
        return seen[0]

    assert asyncio.run(scenario()) == "nested"


def test_cancellation_during_model_call_recovers_capacity() -> None:
    async def scenario() -> None:
        stack = Stack([_final(), _final("again")], concurrency=1, pending=0)
        stack.hold = asyncio.Event()
        task = asyncio.create_task(stack.orchestrator.complete(_invocation("x")))
        while not stack.requests:
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        stack.hold = None
        stack.script = [_final("again")] * 4
        stack.requests.clear()
        result = await stack.orchestrator.complete(_invocation("y"))
        assert result.response.message.content == "again"

    asyncio.run(scenario())


def test_cancellation_during_tool_execution_recovers_tool_capacity() -> None:
    async def scenario() -> None:
        started = asyncio.Event()

        async def hang(arguments: Mapping[str, JsonScalar]) -> object:
            started.set()
            await asyncio.sleep(30)
            return {}

        registry = ToolRegistry()
        registry.register(ToolDefinition("hang", "Hangs."), hang)
        registry.seal()
        stack = Stack([_calls(("call_1", "hang", {}))], registry=registry)
        task = asyncio.create_task(stack.orchestrator.complete(_invocation("x")))
        await started.wait()
        assert stack.executor.active_executions == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stack.executor.active_executions == 0

    asyncio.run(scenario())


def test_independent_requests_do_not_share_tool_state() -> None:
    async def scenario() -> None:
        stack = Stack([])
        stack.script = [
            _add("call_1", 1, 1),
            _final("one"),
            _add("call_1", 2, 2),  # same id is fine in a different request
            _final("two"),
        ]
        first = await stack.orchestrator.complete(_invocation("a"))
        second = await stack.orchestrator.complete(_invocation("b"))
        assert (first.response.message.content, second.response.message.content) == ("one", "two")

    asyncio.run(scenario())


# --- privacy and compatibility --------------------------------------------------------------------


def test_logs_never_contain_prompts_arguments_or_results() -> None:
    stream = io.StringIO()
    logger = build_service_logger("INFO", stream)
    stack = Stack(
        [
            _calls(("call_1", "text_statistics", {"text": "SECRET-ARGUMENT"})),
            _final("SECRET-FINAL"),
        ],
        logger=logger,
    )
    stack.run("SECRET-PROMPT", request_id="req-1")
    output = stream.getvalue()
    assert "SECRET" not in output
    events = [json.loads(line) for line in output.splitlines()]
    finished = next(e for e in events if e["event"] == "tool.orchestration_finished")
    assert finished["tool_rounds"] == 1 and finished["tool_calls"] == 1
    assert any(e["event"] == "tool.execution_finished" for e in events)


def test_tools_are_never_enabled_for_ordinary_completion_and_streaming() -> None:
    stack = Stack([_final("plain")])
    response = asyncio.run(stack.context.complete(_invocation("hi")))
    assert response.message.content == "plain" and stack.requests[0].tools == ()

    async def stream() -> list[StreamEvent]:
        return [event async for event in stack.context.stream(_invocation("hi"))]

    assert isinstance(asyncio.run(stream())[1], ContentDelta)


def test_tool_enabled_streaming_is_rejected_by_the_gateway() -> None:
    stack = Stack([])
    request = CompletionRequest(
        TRUSTED_MODEL, (ChatMessage(MessageRole.USER, "x"),), tools=(CALCULATE,)
    )

    async def drain() -> None:
        async for _ in stack.gateway.stream(request):
            pass

    with pytest.raises(UnsupportedCapabilityError):
        asyncio.run(drain())


def test_application_exposes_internal_orchestrator_only() -> None:
    app = create_app()
    assert isinstance(app.state.tool_orchestrator, ToolCallingOrchestrator)
    assert not any("tool" in path for path in app.openapi()["paths"])


def test_prompt_invocation_for_unrelated_profile_still_valid() -> None:
    assert ContextInvocation(PromptInvocation(PromptIdentifier("chat"), "hi")).prompt.user_content
    assert ToolParameter("n", ParameterType.INTEGER, "n").required
