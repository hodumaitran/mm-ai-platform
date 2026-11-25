# System overview

MM AI Platform is a self-hosted, layered system for private enterprise AI. The intended request path is:

```text
Browser → Next.js → NestJS business API → FastAPI AI service → provider adapter → local model
```

Checkpoint 2.5 implements versioned synchronous and SSE chat transport across the full path while
retaining the Checkpoint 2.4 local provider adapter. PostgreSQL, pgvector, Redis, LangGraph, vLLM,
containers, authentication, and telemetry remain planned infrastructure, not hidden dependencies.

Future capabilities enter through application interfaces rather than importing provider SDKs into
business modules.
