# ADR 0006: Versioned chat API and end-to-end SSE streaming

- Status: Accepted for Checkpoint 2.5 implementation
- Date: 2026-11-25

## Context

Checkpoint 2.4 ended at a private model-neutral gateway and Ollama adapter. A browser transport must
not bypass the business API or expose internal service/provider origins. Streaming must preserve
cancellation, backpressure, correlation, privacy, and the gateway's concurrency authority.

## Decision

Use versioned typed contracts at each HTTP boundary and preserve this path:

`Browser → Next.js server → NestJS → FastAPI → LLM Gateway → provider adapter`.

Next.js implements same-origin POST Route Handlers with server-only NestJS configuration. NestJS owns
a typed AI-service client implemented with Node HTTP streaming, explicit connect/total deadlines,
bounded JSON parsing, AbortSignal propagation, and no retry. FastAPI maps strict public DTOs into the
existing domain contracts and serializes normalized gateway events as SSE.

Public callers cannot select a model/provider, inject system/tool roles, or pass provider-specific
options. One active and one pending inference are allowed per AI-service process. The existing
gateway remains the concurrency authority. SSE does not use EventSource reconnection or application
heartbeats.

## Consequences

- Content streams incrementally without full-response proxy buffers.
- Cancellation closes every upstream response and releases gateway capacity.
- Cold start is accommodated by explicit bounded timeouts rather than unbounded waits.
- The same model-neutral protocol can support future private providers without changing public
  contracts.
- Authentication is still absent, so chat routes are local-development only and are not production
  security ready.
- Admission is per process; distributed coordination remains out of scope.
