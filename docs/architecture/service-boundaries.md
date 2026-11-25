# Service boundaries

## Web (`apps/web`)

Owns UI, browser-facing rendering, and same-origin server transport. It keeps the NestJS origin in
server-only configuration and must not call FastAPI or Ollama directly.

## Business API (`apps/api`)

Owns workflows, policy enforcement, future authorization, and stable application contracts. It may
orchestrate the AI service through its typed internal client but must not depend on a concrete model
or inference engine.

## AI service (`apps/ai-service`)

Owns AI capability orchestration and provider adapters. Its thin HTTP transport maps versioned chat
DTOs to the model-neutral gateway; it does not expose provider payloads.

## Model provider

Ollama is the initial local provider. It remains isolated behind an interface so vLLM or another
private provider can replace it without changing business logic. Provider endpoints remain private.
