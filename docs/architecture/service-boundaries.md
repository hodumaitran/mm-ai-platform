# Service boundaries

## Web (`apps/web`)

Owns UI and browser-facing rendering. It must not hold privileged secrets or call Ollama directly.

## Business API (`apps/api`)

Owns workflows, policy enforcement, future authorization, and stable application contracts. It may
orchestrate the AI service but must not depend on a concrete model or inference engine.

## AI service (`apps/ai-service`)

Owns AI capability orchestration and future provider adapters. Its application layer exposes
model-neutral requests and responses. Current readiness covers configuration only.

## Model provider (future)

Ollama is the initial local provider. It will be isolated behind an interface so vLLM or another
private provider can replace it without changing business logic. Provider endpoints remain private.
