# Context management

Checkpoint 2.7 adds a deterministic, model-neutral context subsystem inside the FastAPI AI service. It
is an internal application entry point: there is no public conversation or context endpoint, and the
chat completion and SSE contracts are unchanged.

## Responsibilities and layers

| Layer          | Module                                             | Responsibility                                                                           |
| -------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Domain         | `domain/context.py`                                | Immutable contracts, validation, source-to-trust mapping, typed errors                   |
| Application    | `application/context.py`                           | `ContextService`: budget, selection, assembly, gateway execution                         |
| Application    | `application/prompts.py` (`PromptService.resolve`) | Validation and rendering of the trusted prompt; unchanged policy, now reusable           |
| Infrastructure | none                                               | No store is justified: the service is stateless and snapshots are caller-supplied values |
| Presentation   | none                                               | No new route                                                                             |

Domain and application import no framework, database, or provider code (enforced by
`tests/test_architecture.py`).

## Contracts

- `ConversationIdentifier`, `ContextIdentifier`: bounded `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`.
- `ConversationTurn`: one **complete** user message plus its assistant reply, with a positive
  `sequence` and its owning conversation identifier. A half turn cannot be represented, so an
  assistant reply can never be kept without its user message.
- `ConversationSnapshot`: immutable, strictly increasing sequences, every turn owned by the snapshot's
  conversation, at most 64 turns, 8,192 characters per message and 65,536 characters in total.
  `from_messages` builds one from role-tagged messages and rejects anything that is not a strict
  user/assistant alternation (system, tool, dangling, or reordered messages).
- `ReferenceMaterial`: caller text (at most 16,384 characters, at most 8 items, unique identifiers).
  It has **no** trust, role, or priority field.
- `ContextInvocation`: the only executable input. It wraps the existing `PromptInvocation`, an optional
  snapshot, and reference items. It has no model, role, trust, budget, or limit field.
- `ContextItem`: one assembled message with `source`, `trust`, `role`, `content`. Trust must equal the
  fixed source mapping and only a trusted-prompt item may use the `system` role; only trusted code
  creates items.
- `ContextSelectionPolicy`: safety margin (0-4,096 tokens), maximum history turns (0-64), maximum
  reference items (0-8).
- `ContextBudget`, `ContextSelectionResult`, `ContextExecutionMetadata`, `ContextAssemblyResult`:
  inspection outputs. A `ContextAssemblyResult` is never accepted for execution.

## Pipeline

`ContextService.prepare` runs, in order:

1. `PromptService.resolve`: resolve the profile and prompt, validate the invocation, variables and
   options, render once, derive the effective limits (`min(profile, gateway defaults, explicit)`).
2. Build the mandatory items (rendered prompt messages and the current request).
3. Estimate the mandatory prompt once with the prompt service's estimator; reject with
   `CONTEXT_BUDGET_EXCEEDED` if `mandatory + output + safety margin` exceeds the effective limit.
4. Select history, then reference material (see `context-budget-policy.md`).
5. Assemble messages: rendered prompt, kept history (chronological), kept references, current request.
6. Validate after assembly: `ContextBudget` rejects any over-commitment and every item is re-checked
   against the trust rules.
7. `complete`/`stream` hand the resulting `CompletionRequest` to the existing `LLMGateway`.

Preparation is synchronous, in-memory, and bounded by the snapshot limits (about 6.5 ms worst case
with the default estimator).

### Request deadline accounting

One budget covers preparation, admission, queue waiting, inference, and streaming. `complete` and
`stream` ask the gateway for the effective total (`LLMGateway.deadline_seconds`: the caller's
`timeout_seconds` validated and capped at the gateway maximum, or the gateway default), start a
`RequestDeadline` on a monotonic clock **before** preparation, and after preparation pass the gateway only
the remainder. An exhausted budget raises `REQUEST_DEADLINE_EXCEEDED` immediately after preparation and
before any provider call; invalid timeout values raise the same error before any preparation. The
gateway's admission, first-content, and inactivity timeouts then run inside that remainder, so nothing
resets between the two phases. For `stream`, the budget starts when iteration begins (generators are
lazy). `PromptService.complete/stream` follow the same rule with an optional `timeout_seconds`, and the
clock is injectable through `PromptService(clock=...)` for deterministic tests.

This is **accounting, not preemption**: preparation is synchronous CPU work that asyncio cannot cancel, so
a slow preparation still runs to completion and the request is rejected afterwards. Hard interruption would
need a thread or process boundary, which is deliberately not introduced; the default estimator is bounded by
the snapshot limits, while a custom slow estimator is the caller's responsibility. The remainder is
computed just before the gateway call, so a few microseconds between that computation and the gateway's own
clock start are not accounted.

_History:_ before this remediation preparation ran outside the deadline (a 0.30 s preparation with a 0.10 s
deadline still completed after 0.303 s); see the Checkpoint 2.7 report, sections 28.3 and 29.

## Conversation lifecycle

Nothing is stored. The caller passes an immutable snapshot with each request. This avoids a shared
mutable registry, capacity management, and lifecycle code with no consumer. A persistent store, if
and when required, would be a separate repository boundary in a later checkpoint.

## Integration and compatibility

`PromptService` behaviour is unchanged: `prepare`, `complete`, and `stream` still accept only a
`PromptInvocation` and rebuild their request. `resolve` was extracted so both services share one
validation path (no duplicated budget or policy logic). `LLMGateway` is the only inference path and
retains admission, deadline, cancellation, capability, and streaming behaviour.

## Not implemented

Persistence, retrieval/RAG, semantic ranking, summarisation or compression, tool calling, a public API,
authentication, and tenant authorization.
