# Tool calling

Phase A (2.8A) added a model-neutral core; Phases B and C (2.8B+C) added native Ollama tool calling and a
bounded orchestrator (see the end of this document). Everything is internal: there is no public tool
endpoint and no frontend, and the Chat API is unchanged.

## Modules

| Layer       | Module                      | Responsibility                                                                     |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------- |
| Domain      | `domain/tools.py`           | `ToolDefinition`, `ToolParameter`, `ToolCall`, `ToolResult`, metadata, bounds      |
| Domain      | `domain/errors.py`          | Typed, sanitized tool errors (see below)                                           |
| Application | `application/tools.py`      | `ToolRegistry` (sealed), `ToolExecutionPolicy`, `ToolExecutor`, `failed_result`    |
| Application | `application/deadline.py`   | Existing `RequestDeadline`, plus shared `validate_timeout_seconds`                 |
| Application | `application/demo_tools.py` | `calculate` and `text_statistics`; `build_demo_registry()` (not wired into `main`) |
| Infra       | `infrastructure/logging.py` | Allowlist gains `tool_name`, `argument_count`, `result_chars`                      |

Domain and application import no framework or provider code (enforced by `tests/test_architecture.py`).

## Contracts

- `ToolDefinition`: name `[a-z][a-z0-9_]{0,47}`, description, at most 8 `ToolParameter`s. Immutable.
- `ToolParameter`: **flat** and strictly typed (`integer`, `number`, `string`, `boolean`) with optional
  numeric bounds, `max_length` (strings, default and cap 4,096) and an `allowed_values` enum. Nested
  arguments are not representable, so there is no recursive schema engine.
- `ToolCall`: untrusted `call_id`, `tool_name`, `arguments`. Construction applies the payload bounds and
  snapshots the arguments into a read-only mapping, so mutating the caller's dictionary afterwards cannot
  change what runs. A call carries no authority.
- `ToolResult`: `succeeded` with JSON `content`, or `failed` with only an `error_code`. Its `trust` is
  always `untrusted`: the content is data, never an instruction. `failed_result(call, error)` builds the
  failed form from a typed error so a later orchestration phase can feed a rejection back to the model.
- `ToolExecutionMetadata`: tool name, outcome, duration, argument count, result size, error code. No
  arguments, results or exception text.

## Execution lifecycle

`ToolExecutor.execute(call, *, timeout_seconds=None, deadline=None)`:

1. Reject anything that is not a `ToolCall`; reject passing both a deadline and a timeout.
2. Establish the budget: use the caller's `RequestDeadline`, or start one from `timeout_seconds`
   (validated: finite, positive, not a boolean) capped at the policy maximum.
3. **Reject an exhausted budget** before any lookup or handler (`REQUEST_DEADLINE_EXCEEDED`).
4. Look the tool up (`TOOL_NOT_FOUND`), check the allowlist (`TOOL_NOT_AUTHORIZED`), validate arguments
   strictly (`INVALID_TOOL_ARGUMENTS`).
5. Re-check the budget (validation may have consumed time), then reserve capacity. When
   `max_concurrency` is reached the call is rejected with `TOOL_OVERLOADED`; there is **no queue**.
6. Run the handler under `asyncio.timeout(min(remaining budget, tool timeout))`.
7. After the handler returns, discard the result if the tool timeout or the request deadline was exceeded
   (this is how a synchronous overrun is caught), then serialize the result deterministically and bound it
   (`TOOL_RESULT_TOO_LARGE`).
8. Release capacity in a `finally`, so failure, timeout and cancellation all recover it.

A tool timeout shorter than the remaining budget raises `TOOL_TIMEOUT`; when the request budget is the
tighter limit the error is `REQUEST_DEADLINE_EXCEEDED`. Handler exceptions become `TOOL_EXECUTION_FAILED`
with no cause chained and no message copied. `CancelledError` propagates untouched. No automatic retries
and no background tasks exist.

## Limits

| Limit                          | Value                     |
| ------------------------------ | ------------------------- |
| Argument depth / nodes         | 3 / 64                    |
| Collection length / key length | 16 / 64                   |
| String argument                | 4,096 characters          |
| Integer magnitude              | 2^53                      |
| Parameters per tool            | 8                         |
| Result (policy, hard cap)      | 4,096 default, 16,384 max |
| Concurrency (policy)           | 2 default, 1 to 64        |
| Tool timeout / request timeout | 5 s / 30 s default        |

## Native integration and orchestration (2.8B+C)

**Contracts.** `ChatMessage` gained optional `tool_calls` (assistant), `tool_call_id` and `tool_name`
(tool role); `CompletionRequest.tools` carries the definitions on offer. A response with tool calls must
use `FinishReason.TOOL_CALL`. All new fields default to empty, so ordinary messages are unchanged.

**Gateway.** A request with tools, or any tool message, needs `capabilities.tool_calling`
(`UNSUPPORTED_CAPABILITY` otherwise). Tool-enabled `stream` is rejected. A response may only call tools
that were offered and may not repeat a call id (`INVALID_PROVIDER_RESPONSE`).

**Ollama adapter.** `tool_calling` is true only when `/api/show` lists `tools`. Definitions map to native
`{"type":"function"}` schemas (`required`, `additionalProperties:false`, bounds, enums). Tool calls are
parsed strictly: object arguments only, bounded payloads, at most 8 calls, any malformed call rejects the
whole response. Call ids are generated by the adapter. Reasoning content is ignored. There is no
text-parsing fallback.

**Orchestrator** (`application/tool_orchestration.py`, `ToolCallingOrchestrator.complete`), reachable as
`app.state.tool_orchestrator` and never used by chat routes:

1. Start one `RequestDeadline`; prepare context once.
2. Offer only `ToolExecutor.authorized_definitions` (registered and allowlisted; the demo `calculate`
   and `text_statistics` tools).
3. Re-validate the whole request, tool schemas and tool exchanges included, before every model call;
   nothing is truncated, overflow raises `CONTEXT_BUDGET_EXCEEDED`.
4. Each gateway call returns (releasing admission) before any tool runs. Calls run sequentially through
   `ToolExecutor` with the same deadline.
5. Results go back as `tool` messages (untrusted data). Per-call failures (`INVALID_TOOL_ARGUMENTS`,
   `TOOL_EXECUTION_FAILED`, `TOOL_TIMEOUT`, `TOOL_RESULT_TOO_LARGE`) are fed back as `{"error": CODE}`
   only; deadline, overload and cancellation propagate.
6. At most 3 tool rounds and 5 calls in total (`TOOL_CALL_LIMIT_EXCEEDED`); the generation after the third
   round offers no tools. A repeated call id raises `DUPLICATE_TOOL_CALL`. No retries, no recursion.

**Limitations.** No tool-enabled streaming. Tool schemas consume context, so a request whose history
already fills the window fails instead of dropping context. A hallucinated or non-allowlisted tool name
aborts the request rather than being fed back. Handlers remain cooperative (no preemption of blocking
code). The allowlist is not authentication or RBAC.

## Known limitations

See `tool-security.md`. Notably: handlers are cooperative coroutines; a handler that blocks the event loop
cannot be preempted (accounting only), and the allowlist is a deployment policy, not authenticated RBAC.
