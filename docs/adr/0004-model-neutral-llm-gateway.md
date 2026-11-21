# ADR 0004: Model-neutral LLM Gateway

- Status: Accepted
- Date: 2026-11-21

## Context

The AI service needs enforceable completion policy before any concrete local provider is connected.
Application code must remain independent of Ollama, Qwen, vLLM, HTTP clients, and future model
choices, while local inference requires strict concurrency and bounded queue waiting.

## Decision

Define frozen provider-neutral domain contracts and a minimal asynchronous `LLMProvider` protocol.
Select one provider through an explicit immutable registry. Place `LLMGateway` in the application
layer and enforce capability validation, explicit generation defaults, an end-to-end `asyncio`
deadline, and a configurable semaphore (default one). Propagate caller cancellation unchanged and
normalize only safe provider/gateway failures.

Define typed async streaming events and validate their order without adding SSE or buffering. Wire an
empty registry into the composition root so readiness remains honest until a concrete adapter is
explicitly supplied.

## Consequences

Provider adapters can change without altering application contracts. Queue waiting and inference
share one deadline, no automatic retry/fallback occurs, and cancellation releases capacity. Domain
and application layers gain no external dependencies. A future Ollama adapter must implement the
protocol and conformance tests in infrastructure; it is not authorized by this decision.
