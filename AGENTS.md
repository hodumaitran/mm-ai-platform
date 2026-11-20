# Engineering standards for coding agents

These rules apply to every automated coding agent working in this repository.

## Scope and architecture

- Implement only the explicitly requested checkpoint. Do not silently expand scope.
- Preserve the service boundary: browser → NestJS API → FastAPI AI service → provider.
- Keep business logic independent of model names, Ollama, vLLM, and external inference APIs.
- Prefer small, testable modules and dependency inversion over framework coupling.
- Do not add databases, queues, cloud services, agents, RAG, or authentication without approval.

## Security and privacy

- Never commit secrets, credentials, private documents, datasets, model weights, or sensitive logs.
- Never send internal data or prompts to external AI services.
- Bind development services to loopback unless the user explicitly approves broader exposure.
- Validate all configuration and untrusted input at service boundaries.
- Do not weaken lint, type, test, or security rules merely to make a check pass.

## Safe execution

- Inspect Git status before and after work; preserve unrelated user changes.
- Do not use destructive commands, rewrite Git history, delete user data, commit, or push without
  explicit authorization.
- Do not change global runtimes, Ollama installation, or model files.
- Use `pnpm.cmd` where Windows PowerShell execution policy blocks script shims.

## Evidence and quality

- Never fabricate command output, test success, coverage, or endpoint responses.
- Mark checks that did not run as `NOT RUN`; mark external blockers as `BLOCKED` with the cause.
- Add or update tests with behavior changes and run the narrow checks before the full quality gate.
- Keep manifests and lockfiles reproducible. Document architecture changes with an ADR.
