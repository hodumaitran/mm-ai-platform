# System overview

MM AI Platform is a self-hosted, layered system for private enterprise AI. The intended request path is:

```text
Browser → Next.js → NestJS business API → FastAPI AI service → provider adapter → local model
```

Checkpoint 2.1 implements the first three service processes and health surfaces. It does not implement
provider adapters or inference calls. PostgreSQL, pgvector, Redis, LangGraph, vLLM, containers, and
telemetry remain planned infrastructure, not hidden runtime dependencies.

Future capabilities enter through application interfaces rather than importing provider SDKs into
business modules.
