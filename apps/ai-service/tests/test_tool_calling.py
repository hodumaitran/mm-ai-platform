import asyncio
import io
import json
import math
from collections.abc import AsyncIterator, Mapping

import pytest

from mm_ai_service.application.deadline import RequestDeadline
from mm_ai_service.application.demo_tools import (
    CALCULATE,
    TEXT_STATISTICS,
    build_demo_registry,
)
from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.application.tools import (
    ToolExecutionPolicy,
    ToolExecutor,
    ToolRegistry,
    failed_result,
)
from mm_ai_service.domain.errors import (
    DuplicateToolRegistrationError,
    InvalidToolArgumentsError,
    InvalidToolCallError,
    InvalidToolDefinitionError,
    InvalidToolPolicyError,
    RequestDeadlineExceededError,
    ServiceError,
    ToolExecutionError,
    ToolNotAuthorizedError,
    ToolOverloadError,
    ToolRegistrySealedError,
    ToolResultTooLargeError,
    ToolTimeoutError,
    UnknownToolError,
)
from mm_ai_service.domain.llm import CompletionRequest, CompletionResponse, StreamEvent
from mm_ai_service.domain.tools import (
    MAX_ARGUMENT_COLLECTION_LENGTH,
    MAX_ARGUMENT_DEPTH,
    MAX_ARGUMENT_STRING_CHARS,
    JsonScalar,
    ParameterType,
    ToolCall,
    ToolDefinition,
    ToolOutcome,
    ToolParameter,
    ToolResult,
    ToolResultTrust,
    check_payload_bounds,
)
from mm_ai_service.infrastructure.logging import SAFE_METADATA_KEYS, build_service_logger
from tests.fakes import FakeProvider
from tests.test_request_deadline import FakeClock

ECHO = ToolDefinition(
    "echo",
    "Echo one bounded string.",
    (ToolParameter("text", ParameterType.STRING, "Text.", max_length=64),),
)


def _call(name: str = "calculate", call_id: str = "call-1", **arguments: object) -> ToolCall:
    return ToolCall(call_id, name, arguments)


def _calc(**arguments: object) -> ToolCall:
    return ToolCall("call-1", "calculate", arguments)


def _registry(*pairs: tuple[ToolDefinition, object]) -> ToolRegistry:
    registry = ToolRegistry()
    for definition, handler in pairs:
        registry.register(definition, handler)  # type: ignore[arg-type]
    registry.seal()
    return registry


async def _echo(arguments: Mapping[str, JsonScalar]) -> object:
    return {"echo": arguments["text"]}


def _executor(
    registry: ToolRegistry | None = None,
    *,
    allowed: frozenset[str] | None = None,
    clock: FakeClock | None = None,
    logger: object = None,
    **policy: object,
) -> ToolExecutor:
    registry = registry or build_demo_registry()
    allowed = registry.names if allowed is None else allowed
    return ToolExecutor(
        registry,
        ToolExecutionPolicy(allowed_tools=allowed, **policy),  # type: ignore[arg-type]
        logger=logger,  # type: ignore[arg-type]
        **({"clock": clock} if clock else {}),
    )


def _run(executor: ToolExecutor, call: ToolCall, **kwargs: object):  # type: ignore[no-untyped-def]
    return asyncio.run(executor.execute(call, **kwargs))  # type: ignore[arg-type]


def _code(error: pytest.ExceptionInfo[BaseException]) -> str:
    assert isinstance(error.value, ServiceError)
    return error.value.code


# --- registry ------------------------------------------------------------------------------------


def test_registry_rejects_duplicates_and_mutation_after_seal() -> None:
    registry = ToolRegistry()
    registry.register(ECHO, _echo)
    with pytest.raises(DuplicateToolRegistrationError):
        registry.register(ECHO, _echo)
    assert not registry.is_sealed
    registry.seal()
    assert registry.is_sealed
    other = ToolDefinition("other", "Another tool.")
    with pytest.raises(ToolRegistrySealedError):
        registry.register(other, _echo)
    assert registry.names == frozenset({"echo"})
    assert registry.definitions == (ECHO,)
    assert registry.get("echo") is not None and registry.get("other") is None


def test_registry_rejects_non_definition_and_non_callable_handlers() -> None:
    registry = ToolRegistry()
    with pytest.raises(InvalidToolPolicyError):
        registry.register("echo", _echo)  # type: ignore[arg-type]
    with pytest.raises(InvalidToolPolicyError):
        registry.register(ECHO, "not callable")  # type: ignore[arg-type]


def test_executor_requires_sealed_registry_and_known_allowlist() -> None:
    open_registry = ToolRegistry()
    with pytest.raises(InvalidToolPolicyError):
        ToolExecutor(open_registry, ToolExecutionPolicy())
    with pytest.raises(InvalidToolPolicyError):
        _executor(allowed=frozenset({"not_registered"}))
    with pytest.raises(InvalidToolPolicyError):
        ToolExecutor(build_demo_registry(), "policy")  # type: ignore[arg-type]


def test_demo_registry_is_sealed_and_complete() -> None:
    registry = build_demo_registry()
    assert registry.is_sealed
    assert registry.names == {"calculate", "text_statistics"}
    assert {CALCULATE, TEXT_STATISTICS} == set(registry.definitions)


@pytest.mark.parametrize(
    "overrides",
    [
        {"allowed_tools": {"calculate"}},
        {"allowed_tools": frozenset({"Bad Name"})},
        {"max_concurrency": 0},
        {"max_concurrency": True},
        {"max_concurrency": 65},
        {"tool_timeout_seconds": 0},
        {"tool_timeout_seconds": float("nan")},
        {"tool_timeout_seconds": float("inf")},
        {"request_timeout_seconds": -1},
        {"tool_timeout_seconds": 10.0, "request_timeout_seconds": 5.0},
        {"max_result_chars": 0},
        {"max_result_chars": 10**6},
    ],
)
def test_policy_rejects_invalid_values(overrides: dict[str, object]) -> None:
    with pytest.raises(InvalidToolPolicyError):
        ToolExecutionPolicy(**overrides)  # type: ignore[arg-type]


# --- definitions and strict argument validation --------------------------------------------------


@pytest.mark.parametrize("name", ["", "Calc", "1calc", "a-b", "x" * 49, "añb"])
def test_tool_definition_rejects_invalid_names(name: str) -> None:
    with pytest.raises(InvalidToolDefinitionError):
        ToolDefinition(name, "Valid description.")


def test_tool_definition_rejects_bad_shapes() -> None:
    parameter = ToolParameter("text", ParameterType.STRING, "Text.")
    for bad in (
        {"description": " "},
        {"description": "x" * 513},
        {"parameters": [parameter]},
        {"parameters": (parameter, parameter)},
        {"parameters": ("text",)},
        {"parameters": (parameter,) * 9},
    ):
        with pytest.raises(InvalidToolDefinitionError):
            ToolDefinition(**{"name": "tool", "description": "Valid.", **bad})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"name": "Bad", "type": ParameterType.STRING},
        {"name": "ok", "type": "string"},
        {"name": "ok", "type": ParameterType.STRING, "minimum": 1},
        {"name": "ok", "type": ParameterType.NUMBER, "minimum": 5, "maximum": 1},
        {"name": "ok", "type": ParameterType.NUMBER, "minimum": float("nan")},
        {"name": "ok", "type": ParameterType.NUMBER, "max_length": 5},
        {"name": "ok", "type": ParameterType.STRING, "max_length": 0},
        {"name": "ok", "type": ParameterType.STRING, "max_length": 10**6},
        {"name": "ok", "type": ParameterType.STRING, "allowed_values": ()},
        {"name": "ok", "type": ParameterType.STRING, "allowed_values": ("a", "a")},
        {"name": "ok", "type": ParameterType.BOOLEAN, "allowed_values": ("a",)},
        {"name": "ok", "type": ParameterType.STRING, "required": "yes"},
    ],
)
def test_parameter_rejects_invalid_schema(kwargs: dict[str, object]) -> None:
    with pytest.raises(InvalidToolDefinitionError):
        ToolParameter(description="A parameter.", **kwargs)  # type: ignore[arg-type]


def test_valid_arguments_are_returned_as_an_immutable_mapping() -> None:
    validated = CALCULATE.validate_arguments({"operation": "add", "left": 1, "right": 2.5})
    assert dict(validated) == {"operation": "add", "left": 1, "right": 2.5}
    with pytest.raises(TypeError):
        validated["left"] = 9  # type: ignore[index]


@pytest.mark.parametrize(
    "arguments",
    [
        {"operation": "add", "left": 1},  # missing required
        {"operation": "add", "left": 1, "right": 2, "extra": 1},  # unexpected field
        {"operation": "pow", "left": 1, "right": 2},  # not in enum
        {"operation": 1, "left": 1, "right": 2},  # wrong type
        {"operation": "add", "left": "1", "right": 2},  # string for number
        {"operation": "add", "left": True, "right": 2},  # bool for number
        {"operation": "add", "left": None, "right": 2},
        {"operation": "add", "left": 1_000_001, "right": 2},  # above maximum
        {"operation": "add", "left": -1_000_001, "right": 2},
        {"operation": "add", "left": [1], "right": 2},  # nested
        {"operation": "add", "left": {"a": 1}, "right": 2},
        {"operation": "x" * 17, "left": 1, "right": 2},  # over max_length
    ],
)
def test_schema_rejects_malformed_arguments(arguments: dict[str, object]) -> None:
    with pytest.raises(InvalidToolArgumentsError):
        CALCULATE.validate_arguments(arguments)


def test_integer_parameters_are_strict() -> None:
    definition = ToolDefinition(
        "count", "Count.", (ToolParameter("n", ParameterType.INTEGER, "N.", minimum=0, maximum=9),)
    )
    assert dict(definition.validate_arguments({"n": 3})) == {"n": 3}
    for bad in (3.0, True, "3", -1, 10, None):
        with pytest.raises(InvalidToolArgumentsError):
            definition.validate_arguments({"n": bad})


def test_boolean_and_optional_parameters() -> None:
    definition = ToolDefinition(
        "flag",
        "Flag.",
        (
            ToolParameter("on", ParameterType.BOOLEAN, "On."),
            ToolParameter("note", ParameterType.STRING, "Note.", required=False, max_length=4),
        ),
    )
    assert dict(definition.validate_arguments({"on": False})) == {"on": False}
    for bad in ({"on": 1}, {"on": "true"}, {"on": True, "note": "toolong"}, {}):
        with pytest.raises(InvalidToolArgumentsError):
            definition.validate_arguments(bad)


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_non_finite_numbers_are_rejected_at_call_and_schema_level(value: float) -> None:
    with pytest.raises(InvalidToolArgumentsError):
        _calc(operation="add", left=value, right=1)
    with pytest.raises(InvalidToolArgumentsError):
        CALCULATE.parameters[1].validate(value)


# --- payload bounds and call snapshot ------------------------------------------------------------


def _nested(depth: int) -> object:
    value: object = 1
    for _ in range(depth):
        value = {"k": value}
    return value


def test_payload_depth_node_collection_and_string_limits() -> None:
    check_payload_bounds({"a": _nested(MAX_ARGUMENT_DEPTH - 1)})
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({"a": _nested(MAX_ARGUMENT_DEPTH + 1)})
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({"a": list(range(MAX_ARGUMENT_COLLECTION_LENGTH + 1))})
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({f"k{i}": 1 for i in range(MAX_ARGUMENT_COLLECTION_LENGTH + 1)})
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({"a": "x" * (MAX_ARGUMENT_STRING_CHARS + 1)})
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({"a": [[1] * 16] * 16})  # too many nodes overall
    with pytest.raises(InvalidToolArgumentsError):
        check_payload_bounds({"a": 10**30})


def test_payload_rejects_cycles_and_non_json_types() -> None:
    cyclic: dict[str, object] = {}
    cyclic["self"] = cyclic
    for bad in (cyclic, {"a": {1, 2}}, {"a": b"bytes"}, {"a": object()}, {1: "x"}, {"a": 1j}):
        with pytest.raises(InvalidToolArgumentsError):
            check_payload_bounds(bad)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"call_id": "", "tool_name": "calculate", "arguments": {}},
        {"call_id": "bad id", "tool_name": "calculate", "arguments": {}},
        {"call_id": "ok", "tool_name": "Calculate", "arguments": {}},
        {"call_id": "ok", "tool_name": "calculate; rm -rf /", "arguments": {}},
        {"call_id": 1, "tool_name": "calculate", "arguments": {}},
        {"call_id": "ok", "tool_name": "calculate", "arguments": [1]},
        {"call_id": "ok", "tool_name": "calculate", "arguments": None},
    ],
)
def test_tool_call_rejects_malformed_identity(kwargs: dict[str, object]) -> None:
    with pytest.raises(InvalidToolCallError):
        ToolCall(**kwargs)  # type: ignore[arg-type]


def test_tool_call_snapshots_arguments() -> None:
    original = {"text": "before"}
    call = ToolCall("c1", "echo", original)
    original["text"] = "after"
    assert call.arguments["text"] == "before"
    with pytest.raises(TypeError):
        call.arguments["text"] = "x"  # type: ignore[index]


# --- execution: success, deny-by-default, validation --------------------------------------------


def test_successful_deterministic_execution_and_metadata() -> None:
    executor = _executor()
    execution = _run(executor, _calc(operation="multiply", left=6, right=7))
    assert execution.result.outcome is ToolOutcome.SUCCEEDED
    assert execution.result.trust is ToolResultTrust.UNTRUSTED
    assert execution.result.call_id == "call-1"
    assert json.loads(execution.result.content) == {"operation": "multiply", "result": 42}
    assert execution.result.content == '{"operation":"multiply","result":42}'
    assert execution.metadata.argument_count == 3
    assert execution.metadata.result_chars == len(execution.result.content)
    assert execution.metadata.tool_name == "calculate"
    again = _run(executor, _calc(operation="multiply", left=6, right=7))
    assert again.result.content == execution.result.content


def test_text_statistics_counts_unicode_deterministically() -> None:
    execution = _run(_executor(), _call("text_statistics", text="xin chào\nthế giới"))
    assert json.loads(execution.result.content) == {
        "characters": 17,
        "lines": 2,
        "utf8_bytes": len("xin chào\nthế giới".encode()),
        "words": 4,
    }


def test_division_and_float_results() -> None:
    result = _run(_executor(), _calc(operation="divide", left=1, right=4)).result
    assert json.loads(result.content)["result"] == 0.25


def test_default_policy_denies_everything() -> None:
    executor = ToolExecutor(build_demo_registry(), ToolExecutionPolicy())
    with pytest.raises(ToolNotAuthorizedError):
        _run(executor, _calc(operation="add", left=1, right=1))


def test_registered_but_not_allowed_tool_is_denied_and_never_runs() -> None:
    calls: list[int] = []

    async def handler(arguments: Mapping[str, JsonScalar]) -> object:
        calls.append(1)
        return {}

    registry = _registry((ECHO, handler))
    with pytest.raises(ToolNotAuthorizedError):
        _run(_executor(registry, allowed=frozenset()), _call("echo", text="x"))
    assert calls == []


def test_unknown_tool_is_rejected() -> None:
    with pytest.raises(UnknownToolError):
        _run(_executor(), _call("does_not_exist"))


def test_invalid_arguments_never_reach_the_handler() -> None:
    calls: list[int] = []

    async def handler(arguments: Mapping[str, JsonScalar]) -> object:
        calls.append(1)
        return {}

    executor = _executor(_registry((ECHO, handler)))
    for bad in ({}, {"text": 1}, {"text": "x", "extra": 1}, {"text": "x" * 65}):
        with pytest.raises(InvalidToolArgumentsError):
            _run(executor, ToolCall("c", "echo", bad))
    assert calls == [] and executor.active_executions == 0


def test_executor_rejects_non_tool_call_inputs() -> None:
    with pytest.raises(InvalidToolCallError):
        _run(_executor(), {"tool_name": "calculate"})  # type: ignore[arg-type]


# --- handler failures, result bounds -------------------------------------------------------------


def test_handler_exception_is_sanitized() -> None:
    async def boom(arguments: Mapping[str, JsonScalar]) -> object:
        raise RuntimeError("SECRET-DB-PASSWORD at /etc/shadow")

    with pytest.raises(ToolExecutionError) as caught:
        _run(_executor(_registry((ECHO, boom))), _call("echo", text="x"))
    error = caught.value
    assert error.code == "TOOL_EXECUTION_FAILED" and error.__cause__ is None
    assert "SECRET" not in error.public_message and "SECRET" not in repr(error.args)
    assert error.__suppress_context__


def test_handler_raised_timeout_error_is_a_failure_not_a_timeout() -> None:
    async def raising(arguments: Mapping[str, JsonScalar]) -> object:
        raise TimeoutError("inner")

    with pytest.raises(ToolExecutionError):
        _run(_executor(_registry((ECHO, raising))), _call("echo", text="x"))


def test_division_by_zero_is_sanitized() -> None:
    with pytest.raises(ToolExecutionError):
        _run(_executor(), _calc(operation="divide", left=1, right=0))


def test_handler_service_errors_pass_through_unchanged() -> None:
    async def refuse(arguments: Mapping[str, JsonScalar]) -> object:
        raise ToolResultTooLargeError()

    with pytest.raises(ToolResultTooLargeError):
        _run(_executor(_registry((ECHO, refuse))), _call("echo", text="x"))


def test_oversized_and_unserializable_results_are_rejected() -> None:
    async def big(arguments: Mapping[str, JsonScalar]) -> object:
        return {"data": "x" * 200}

    async def nan(arguments: Mapping[str, JsonScalar]) -> object:
        return {"data": math.nan}

    async def weird(arguments: Mapping[str, JsonScalar]) -> object:
        return {"data": object()}

    async def deep(arguments: Mapping[str, JsonScalar]) -> object:
        return _nested(10)

    for handler in (big, nan, weird, deep):
        executor = _executor(_registry((ECHO, handler)), max_result_chars=100)
        with pytest.raises(ToolResultTooLargeError):
            _run(executor, _call("echo", text="x"))
        assert executor.active_executions == 0


def test_result_at_limit_is_accepted() -> None:
    async def exact(arguments: Mapping[str, JsonScalar]) -> object:
        return "y" * 10

    content = _run(
        _executor(_registry((ECHO, exact)), max_result_chars=12), _call("echo", text="x")
    )
    assert content.result.content == '"' + "y" * 10 + '"'


def test_tool_result_invariants() -> None:
    assert failed_result(_calc(operation="add", left=1, right=1), UnknownToolError()) == ToolResult(
        "call-1", "calculate", ToolOutcome.FAILED, error_code="TOOL_NOT_FOUND"
    )
    for kwargs in (
        {"outcome": ToolOutcome.SUCCEEDED, "error_code": "X"},
        {"outcome": ToolOutcome.FAILED},
        {"outcome": ToolOutcome.FAILED, "error_code": "X", "content": "leak"},
        {"outcome": "succeeded"},
        {"outcome": ToolOutcome.SUCCEEDED, "content": "x" * 20_000},
    ):
        with pytest.raises(InvalidToolCallError):
            ToolResult("c", "calculate", **kwargs)


# --- deadline, timeout, cancellation -------------------------------------------------------------


@pytest.mark.parametrize(
    "bad", [0, -1, -0.5, math.nan, math.inf, -math.inf, True, False, "5", None]
)
def test_invalid_timeouts_are_rejected_before_any_handler(bad: object) -> None:
    calls: list[int] = []

    async def handler(arguments: Mapping[str, JsonScalar]) -> object:
        calls.append(1)
        return {}

    executor = _executor(_registry((ECHO, handler)))
    if bad is None:
        _run(executor, _call("echo", text="x"), timeout_seconds=None)
        assert calls == [1]
        return
    with pytest.raises(RequestDeadlineExceededError):
        _run(executor, _call("echo", text="x"), timeout_seconds=bad)
    assert calls == [1][:0]


def test_deadline_and_timeout_together_are_rejected() -> None:
    clock = FakeClock()
    with pytest.raises(InvalidToolCallError):
        _run(
            _executor(clock=clock),
            _calc(operation="add", left=1, right=1),
            timeout_seconds=1.0,
            deadline=RequestDeadline(1.0, clock),
        )


def test_expired_deadline_rejects_before_handler_and_never_extends() -> None:
    clock = FakeClock()
    calls: list[int] = []

    async def handler(arguments: Mapping[str, JsonScalar]) -> object:
        calls.append(1)
        return {}

    executor = _executor(_registry((ECHO, handler)), clock=clock)
    deadline = RequestDeadline(1.0, clock)
    clock.now += 1.0  # exactly exhausted
    with pytest.raises(RequestDeadlineExceededError):
        _run(executor, _call("echo", text="x"), deadline=deadline)
    clock.now += 100
    with pytest.raises(RequestDeadlineExceededError):  # time never flows back
        _run(executor, _call("echo", text="x"), deadline=deadline)
    assert calls == [] and executor.active_executions == 0


def test_shared_deadline_is_consumed_across_preparation_and_tools() -> None:
    clock = FakeClock()

    async def slow(arguments: Mapping[str, JsonScalar]) -> object:
        clock.now += 0.4
        return {"ok": True}

    executor = _executor(_registry((ECHO, slow)), clock=clock, tool_timeout_seconds=1.0)
    deadline = RequestDeadline(1.0, clock)
    clock.now += 0.3  # preparation already used 0.3 s
    first = _run(executor, _call("echo", text="a"), deadline=deadline)
    assert first.result.outcome is ToolOutcome.SUCCEEDED  # 0.7 s used, 0.3 s left
    with pytest.raises(RequestDeadlineExceededError):  # handler takes 0.4 > 0.3 left (sync overrun)
        _run(executor, _call("echo", text="b"), deadline=deadline)


def test_policy_maximum_caps_a_larger_caller_timeout() -> None:
    clock = FakeClock()

    async def slow(arguments: Mapping[str, JsonScalar]) -> object:
        clock.now += 3.0
        return {}

    executor = _executor(
        _registry((ECHO, slow)),
        clock=clock,
        tool_timeout_seconds=2.0,
        request_timeout_seconds=2.0,
    )
    with pytest.raises(RequestDeadlineExceededError):
        _run(executor, _call("echo", text="x"), timeout_seconds=3600)


def test_per_tool_timeout_is_distinct_from_request_deadline() -> None:
    async def hang(arguments: Mapping[str, JsonScalar]) -> object:
        await asyncio.sleep(5)
        return {}

    registry = _registry((ECHO, hang))
    executor = _executor(registry, tool_timeout_seconds=0.05, request_timeout_seconds=5.0)
    with pytest.raises(ToolTimeoutError):
        _run(executor, _call("echo", text="x"), timeout_seconds=2.0)
    assert executor.active_executions == 0
    with pytest.raises(RequestDeadlineExceededError):  # budget shorter than the tool limit
        _run(executor, _call("echo", text="x"), timeout_seconds=0.03)
    assert executor.active_executions == 0


def test_synchronous_overrun_is_detected_and_result_discarded() -> None:
    clock = FakeClock()

    async def blocking(arguments: Mapping[str, JsonScalar]) -> object:
        clock.now += 2.0  # simulates a handler that blocks the loop; asyncio cannot interrupt it
        return {"late": "data"}

    executor = _executor(
        _registry((ECHO, blocking)),
        clock=clock,
        tool_timeout_seconds=1.0,
        request_timeout_seconds=10.0,
    )
    with pytest.raises(ToolTimeoutError):
        _run(executor, _call("echo", text="x"), timeout_seconds=10.0)
    assert executor.active_executions == 0


def test_cancellation_propagates_and_releases_capacity() -> None:
    async def scenario() -> None:
        started = asyncio.Event()

        async def hang(arguments: Mapping[str, JsonScalar]) -> object:
            started.set()
            await asyncio.sleep(30)
            return {}

        executor = _executor(_registry((ECHO, hang)), max_concurrency=1)
        task = asyncio.create_task(executor.execute(_call("echo", text="x")))
        await started.wait()
        assert executor.active_executions == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert executor.active_executions == 0
        ok = _executor(build_demo_registry(), max_concurrency=1)
        await ok.execute(_calc(operation="add", left=1, right=2))

    asyncio.run(scenario())


# --- concurrency, capacity recovery, isolation --------------------------------------------------


def test_capacity_is_bounded_without_queueing_and_recovers() -> None:
    async def scenario() -> None:
        release = asyncio.Event()
        started = asyncio.Event()

        async def gated(arguments: Mapping[str, JsonScalar]) -> object:
            started.set()
            await release.wait()
            return {"text": arguments["text"]}

        executor = _executor(_registry((ECHO, gated)), max_concurrency=1)
        first = asyncio.create_task(executor.execute(_call("echo", "c1", text="a")))
        await started.wait()
        with pytest.raises(ToolOverloadError):  # immediate rejection, no parked request
            await executor.execute(_call("echo", "c2", text="b"))
        assert executor.active_executions == 1
        release.set()
        assert (await first).result.call_id == "c1"
        assert executor.active_executions == 0
        assert (await executor.execute(_call("echo", "c3", text="c"))).result.call_id == "c3"

    asyncio.run(scenario())


def test_capacity_recovers_after_failure_timeout_and_overload() -> None:
    async def scenario() -> None:
        async def fail(arguments: Mapping[str, JsonScalar]) -> object:
            raise ValueError("boom")

        async def hang(arguments: Mapping[str, JsonScalar]) -> object:
            await asyncio.sleep(30)
            return {}

        other = ToolDefinition("hang", "Hangs.", ())
        registry = _registry((ECHO, fail), (other, hang))
        executor = _executor(registry, max_concurrency=1, tool_timeout_seconds=0.05)
        for _ in range(3):
            with pytest.raises(ToolExecutionError):
                await executor.execute(_call("echo", text="x"))
            with pytest.raises(ToolTimeoutError):
                await executor.execute(_call("hang"))
            assert executor.active_executions == 0

    asyncio.run(scenario())


def test_concurrent_requests_are_isolated() -> None:
    async def scenario() -> None:
        executor = _executor(max_concurrency=8)
        calls = [
            ToolCall(f"c{i}", "calculate", {"operation": "add", "left": i, "right": 100})
            for i in range(8)
        ]
        results = await asyncio.gather(*(executor.execute(call) for call in calls))
        for index, execution in enumerate(results):
            assert execution.result.call_id == f"c{index}"
            assert json.loads(execution.result.content)["result"] == index + 100

    asyncio.run(scenario())


def test_handler_cannot_mutate_arguments_or_leak_state_between_calls() -> None:
    seen: list[Mapping[str, JsonScalar]] = []

    async def tamper(arguments: Mapping[str, JsonScalar]) -> object:
        seen.append(arguments)
        arguments["text"] = "tampered"  # type: ignore[index]
        return {}

    executor = _executor(_registry((ECHO, tamper)))
    call = _call("echo", text="original")
    with pytest.raises(ToolExecutionError):
        _run(executor, call)
    assert call.arguments["text"] == "original" and seen[0]["text"] == "original"
    with pytest.raises(ToolExecutionError):
        _run(executor, _call("echo", text="second"))
    assert seen[0] is not seen[1] and seen[1]["text"] == "second"


# --- logging privacy ---------------------------------------------------------------------------


def test_logs_contain_only_content_free_metadata() -> None:
    stream = io.StringIO()
    logger = build_service_logger("INFO", stream)

    async def leaky(arguments: Mapping[str, JsonScalar]) -> object:
        if arguments["text"] == "SECRET-FAIL":
            raise RuntimeError("SECRET-EXCEPTION")
        return {"echo": "SECRET-RESULT"}

    executor = _executor(_registry((ECHO, leaky)), logger=logger)
    _run(executor, _call("echo", "SECRET-CALL-ID", text="SECRET-ARGUMENT"))
    with pytest.raises(ToolExecutionError):
        _run(executor, _call("echo", text="SECRET-FAIL"))
    with pytest.raises(InvalidToolArgumentsError):
        _run(executor, _call("echo", text=1))
    with pytest.raises(UnknownToolError):
        _run(executor, _call("secret_unknown_tool"))
    with pytest.raises(ToolNotAuthorizedError):
        _run(
            _executor(_registry((ECHO, leaky)), allowed=frozenset(), logger=logger),
            _call("echo", text="x"),
        )
    output = stream.getvalue()
    for secret in ("SECRET", "secret_unknown_tool"):
        assert secret not in output
    events = [json.loads(line) for line in output.splitlines()]
    names = {event["event"] for event in events}
    assert {"tool.execution_started", "tool.execution_finished", "tool.execution_failed"} <= names
    finished = next(event for event in events if event["event"] == "tool.execution_finished")
    assert finished["tool_name"] == "echo" and finished["argument_count"] == 1
    assert finished["result_chars"] > 0 and finished["outcome"] == "succeeded"
    failed = next(event for event in events if event["event"] == "tool.execution_failed")
    assert failed["error_code"] == "TOOL_EXECUTION_FAILED"
    assert {"arguments", "result", "content", "call_id"}.isdisjoint(SAFE_METADATA_KEYS)


# --- gateway deadline policy (shared validation) -------------------------------------------------


async def _unused_completion(request: CompletionRequest) -> CompletionResponse:
    raise AssertionError("provider must not be reached")


async def _unused_stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
    raise AssertionError("provider must not be reached")
    yield  # pragma: no cover


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf, True, 0, -1, "1"])
def test_gateway_deadline_rejects_non_finite_and_invalid_timeouts(bad: object) -> None:
    provider = FakeProvider(_unused_completion, _unused_stream)
    gateway = LLMGateway(ProviderRegistry((provider,), "fake"), GatewayPolicy())
    with pytest.raises(RequestDeadlineExceededError):
        gateway.deadline_seconds(bad)  # type: ignore[arg-type]
    assert gateway.deadline_seconds(5) == 5.0
    assert gateway.deadline_seconds(10**9) == GatewayPolicy().request_timeout_seconds
