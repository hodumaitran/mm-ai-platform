# ADR 0009: Model-neutral tool calling core

- Status: Accepted (Checkpoint 2.8A)
- Date: 2026-11-26

## Context

Later checkpoints need models to request tools. The platform must keep business logic independent of
model names and providers, treat model output as untrusted, and keep one request deadline. Ollama's
native tool calling is not enabled (`tool_calling=False`).

## Decision

1. **Domain contracts** (`domain/tools.py`): immutable definitions with flat, strictly typed argument
   schemas; untrusted `ToolCall`; `ToolResult` always tagged untrusted.
2. **Explicit sealed registry** populated by trusted code at startup. No dynamic import, no runtime
   registration.
3. **Application-owned policy**: an allowlist that defaults to empty, concurrency, per-tool and request
   timeouts, result size. Authorization is a deployment allowlist, not RBAC.
4. **Bounded executor** reusing `RequestDeadline`: the caller's budget is continued, never reset; expired
   budgets are rejected before handlers; capacity is bounded without a queue; no retries or background
   tasks.
5. **Shared timeout validation** (`validate_timeout_seconds`) used by the gateway and the executor.
6. **No provider coupling** and no orchestration loop in this phase.

## Alternatives rejected

- A general JSON Schema engine: a dependency and recursive attack surface for no current consumer.
- Queueing excess calls: an unbounded or hidden latency source; rejection is explicit and testable.
- Executing handlers in threads or processes: stronger isolation but new lifecycle and failure modes.
  Deferred until a tool needs it.
- Returning failures as results only: request-level failures (deadline, overload, cancellation) must
  propagate. `failed_result` covers feedback for later phases.

## Consequences

- Handlers must be cooperative; synchronous overruns are detected after the fact, not interrupted.
- The gateway deadline policy now rejects NaN and infinity.
- Phase B can add provider tool-call parsing and a bounded multi-round loop on top without changing these
  contracts.
