# ADR 0008: Stateless, trust-classified context management in the AI service

## Status

Accepted for Checkpoint 2.7.

## Context

Checkpoint 2.6 produced a sealed prompt registry and a single execution path. Multi-turn requests,
reference material, and bounded context need one place that decides what reaches the model, without
adding storage, retrieval, or a public API, and without weakening execution integrity.

## Decision

Add immutable domain contracts and an application `ContextService` that wraps `PromptService`.
History is a caller-supplied immutable snapshot of complete turns. Trust is derived from the source,
never accepted from callers. Budgeting reuses the Prompt Management `TokenEstimator` and effective
limits; mandatory content is never truncated and optional content is dropped only by an explicit,
reported policy (newest whole turns first, then reference material first-fit). `PromptService.resolve`
was extracted so validation and limits exist once. The only executable input is `ContextInvocation`;
assembly results are inspection-only and execution always goes through the existing `LLMGateway`.

## Consequences

- No storage, store lifecycle, or process-global state; isolation is structural, not tenant-level.
- No competing estimator; budgets are labelled estimates unless a real tokenizer is supplied later.
- A future persistent conversation store, retrieval pipeline, or agent can supply snapshots and
  reference items through the same contracts without changing the pipeline.
- Caller-supplied history is untrusted and forgeable until authentication exists.
- Semantic prompt injection remains residual (Checkpoint 2.9).
