# ADR 0002: Model-agnostic AI platform boundary

- Status: Accepted
- Date: 2026-11-20

## Context

Ollama and Qwen3.5 are initial local choices; later benchmarks may select vLLM or larger models.

## Decision

Inference will pass from NestJS into a model-neutral FastAPI contract. Provider transport, model names,
thinking controls, and lifecycle settings belong in adapter/configuration code. The browser never calls
a provider directly.

## Consequences

Each provider requires an adapter and conformance tests. Provider features surface only through explicit
capability negotiation, avoiding leakage into business modules.
