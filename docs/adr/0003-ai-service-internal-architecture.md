# ADR 0003: Layered AI service composition and operational contracts

- Status: Accepted
- Date: 2026-11-20

## Context

The initial FastAPI service used module-level settings and application objects. Before provider or LLM
gateway work, it needs testable composition, deterministic cleanup, safe correlation, and explicit
internal dependency rules without inventing provider abstractions.

## Decision

Use four internal layers: domain, application, infrastructure, and presentation. Keep
`create_app` as the composition root and inject settings, a small event-logging port, and only managed
resources actually used by an application. Use FastAPI lifespan for ordered startup, rollback, and
reverse shutdown. Use pure ASGI request middleware with a resettable `ContextVar`. Map domain and
framework failures to stable machine codes, and emit local JSON logs through an allowlisted metadata
adapter.

Do not use a dependency-injection framework, global application object, provider client, external
telemetry exporter, or future inference configuration in this checkpoint.

## Consequences

Application instances are isolated and Uvicorn factory-compatible. Domain/application code remains
independent of FastAPI and model-specific infrastructure, enforced by tests. Operational contracts
are more explicit, at the cost of several small adapter modules. The future LLM Gateway must enter
through an application port and a separately reviewed infrastructure adapter.
