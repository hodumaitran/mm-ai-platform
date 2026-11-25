# ADR 0005: Lifecycle-managed local Ollama provider

- Status: Accepted
- Date: 2026-11-21

## Context

Checkpoint 2.3 deliberately ends at a provider-neutral gateway. A concrete local provider must map
Ollama without leaking its API schema into domain/application code, while confidential prompts must
not follow proxies or public URLs. Readiness needs provider/model truth without generating text or
loading a model.

## Decision

Implement `OllamaProvider` in infrastructure with one lifespan-owned pooled `httpx.AsyncClient`.
Disable environment proxies and redirects, require loopback by default, and permit literal private
IPs only through an explicit production policy. Bind the adapter to one configured model.

Use `/api/version`, `/api/tags`, and `/api/show` for a bounded cached readiness probe. Treat model
inventory and completion compatibility as separate states. Map `/api/chat` JSON/NDJSON to the
existing completion/stream contracts, discard reasoning output, and add the provider-neutral
`MODEL_UNAVAILABLE` error required to distinguish model absence from service failure.

## Consequences

The gateway remains unchanged and provider-neutral. HTTP pooling and cleanup follow the existing
lifespan. Readiness causes bounded local metadata traffic but no inference. A missing model degrades
readiness and blocks integration prompts; it never triggers a pull. Tool calls, structured output,
public chat/SSE, cloud Ollama, and external fallbacks remain out of scope.
