# Checkpoint 2.3: Enterprise model-neutral LLM Gateway

- Date: 2026-11-21
- Baseline: `03ed5da` (`feat(ai-service): establish clean architecture foundation`)
- Status: **PASS**
- Scope: internal provider-neutral LLM contracts and gateway; no real adapter or inference

## 1. Executive summary

Checkpoint 2.3 is accepted locally. The FastAPI AI service now contains immutable provider-neutral
completion contracts, an explicit provider protocol and registry, and an application-layer gateway
with capability checks, bounded concurrency, an end-to-end deadline, cancellation propagation, safe
error normalization, and typed streaming events.

All required local gates pass. The repository has 94 passing tests: 81 Python, 8 NestJS unit, 2
NestJS e2e, and 3 web tests. No real provider adapter, outbound inference, public chat/streaming
endpoint, model download, RAG, agent, database, authentication, or external telemetry was added.

## 2. Initial repository audit

The pre-implementation audit read `AGENTS.md`, README, ADRs 0001 through 0003, the security baseline,
Checkpoint 2.2 documentation, all AI-service source/tests, manifests, lockfiles, Git status, and the
latest commits. Branch `main` was clean at `03ed5da`, one commit ahead of `origin/main`; the approved
Checkpoint 2.2 commit was therefore a clean foundation rather than an uncommitted recovery state.

The reported Checkpoint 2.2 baseline was independently rechecked before implementation with
`pnpm.cmd check`: its 24 Python tests and 13 JavaScript tests passed. Reusable boundaries included
the application factory, inward-only layers, frozen settings, safe `ServiceError`, correlation-aware
logging, deterministic lifespan, and honest health/readiness contracts.

## 3. Architecture decisions

ADR 0004 selects frozen domain values, a structural asynchronous `LLMProvider` protocol, explicit
immutable registration, and one configured provider identifier. `LLMGateway` is an application
service and knows no HTTP client, provider SDK, endpoint, credential, or concrete model family.

One `asyncio.Semaphore` enforces configured capacity. One `asyncio.timeout` encloses both semaphore
waiting and provider execution/stream iteration, producing a clear end-to-end deadline. There is no
retry, fallback, dynamic discovery, background queue, or dependency-injection framework.

## 4. Final directory tree

```text
apps/ai-service/
  src/mm_ai_service/
    application/
      gateway.py
      providers.py
      registry.py
      lifecycle.py
      observability.py
      readiness.py
    domain/
      errors.py
      llm.py
    infrastructure/
      lifecycle.py
      logging.py
    presentation/
      errors.py
      middleware.py
      request_context.py
      routes.py
    config.py
    main.py
  tests/
    fakes.py
    test_architecture.py
    test_config.py
    test_errors.py
    test_factory_lifecycle.py
    test_gateway.py
    test_gateway_concurrency.py
    test_health.py
    test_llm_contracts.py
    test_logging.py
    test_provider_registry.py
    test_request_context.py
    test_streaming.py
docs/
  adr/0004-model-neutral-llm-gateway.md
  architecture/llm-gateway.md
  architecture/llm-provider-contracts.md
  checkpoints/checkpoint-2.3.md
```

## 5. Domain contracts

`ChatMessage`, `CompletionRequest`, `CompletionResponse`, `GenerationOptions`, `TokenUsage`,
`ModelCapabilities`, thinking configuration, finish reasons, and stream events are frozen slotted
dataclasses. Identifiers, roles, non-empty content, finite temperature, positive limits, context/output
relationships, bounded stop sequences, token accounting, response role, and scalar metadata are
validated. Unknown token usage remains three explicit `None` values and is never fabricated.

Response metadata is bounded to 32 unique validated keys and immutable scalar values. Mutable nested
data, overlong strings, and non-finite numbers are rejected. Contracts contain no Qwen-, Ollama-, or
vLLM-specific field.

## 6. Provider protocol

`LLMProvider` declares a stable provider ID, immutable capabilities, asynchronous completion, and an
async-iterator stream. Future infrastructure adapters must validate raw payloads, translate transport
failures into the stable taxonomy, propagate cancellation, clean up their transport, and never log
prompts, completions, reasoning traces, credentials, URLs, or raw exception messages.

Checkpoint tests use only `FakeProvider`, a deterministic in-memory implementation. No integration
test or production adapter connects to Ollama or another service.

## 7. Gateway application service

The gateway resolves the selected provider, checks chat/thinking/tool/streaming/context capabilities,
merges explicit generation defaults, acquires bounded capacity, executes the provider, validates the
returned model/event contract, and returns provider-neutral values. Defaults are temperature `0.2`,
maximum output `1024`, context `4096`, concurrency `1`, and timeout `120` seconds; all are validated
configuration.

Unexpected exceptions become `INTERNAL_GATEWAY_FAILURE` without exposing their text. Already
normalized `ServiceError` instances retain their safe category. Logs contain only fixed event names
and allowlisted machine error codes.

## 8. Provider selection

`ProviderRegistry` snapshots the injected provider sequence into a read-only mapping and selects only
`AI_SERVICE_LLM_PROVIDER`. Duplicate or syntactically invalid IDs fail configuration. Missing and
unknown selections are distinct typed errors under `PROVIDER_UNAVAILABLE`. There is no discovery,
fallback, network probe, or external service substitution.

The production composition root injects no providers, so the default registry is unavailable and
`/ready` continues to report `ollama: false` and `inference: false`. A test-only explicitly selected
fake provider makes `inference` true without contacting a model.

## 9. Timeout, concurrency, and cancellation

The configured semaphore defaults to one concurrent provider operation. The end-to-end timeout
includes queue waiting and the complete provider call or entire stream iteration, preventing an
unbounded wait. Timeouts become `PROVIDER_TIMEOUT`; no retry is attempted.

Context managers release the semaphore after success, normalized failure, unknown failure, timeout,
or cancellation. Caller `asyncio.CancelledError` is logged as a safe event and re-raised unchanged,
not converted into a 500 error. Tests verify maximum concurrency one, queue deadline coverage,
capacity release after provider failure, and capacity release/cancellation cleanup for completion and
streaming.

## 10. Thinking and streaming contracts

Thinking modes are `default`, `enabled`, and `disabled`. Only enabled mode requires declared thinking
support; no reasoning trace is represented, returned, fabricated, or logged. Provider-specific
translation is deferred.

Streaming uses typed `StreamStarted`, `ContentDelta`, `UsageUpdate`, `CompletionFinished`, and
`StreamError` events. The gateway requires a matching start event, known event types, exactly ordered
terminal behavior, and a terminal finish/error. Events are yielded immediately without buffering or
fake splitting. No SSE or public chat route exists.

## 11. Error taxonomy

| Code                          | Meaning                                   | Future HTTP |
| ----------------------------- | ----------------------------------------- | ----------: |
| `INVALID_COMPLETION_REQUEST`  | Invalid client completion contract        |         400 |
| `PROVIDER_UNAVAILABLE`        | Missing, unknown, or unavailable provider |         503 |
| `PROVIDER_CONNECTION_FAILURE` | Provider transport connection failed      |         503 |
| `PROVIDER_TIMEOUT`            | End-to-end deadline expired               |         504 |
| `PROVIDER_OVERLOAD`           | Provider rejected capacity                |         503 |
| `UNSUPPORTED_CAPABILITY`      | Requested feature is not declared         |         422 |
| `INVALID_PROVIDER_RESPONSE`   | Provider returned an invalid contract     |         502 |
| `REQUEST_CANCELLED`           | Future remote cancellation convention     |         499 |
| `INTERNAL_GATEWAY_FAILURE`    | Safe unexpected gateway failure           |         500 |

These extend the Checkpoint 2.2 `ServiceError` contract. Public messages are fixed and do not accept
raw provider detail. Local caller cancellation remains `asyncio.CancelledError`; the 499 category is
reserved for a future adapter-normalized remote cancellation.

## 12. Security and privacy review

- External AI APIs, provider calls, model loading/downloads: **NOT IMPLEMENTED**.
- Domain/application imports of FastAPI, HTTP clients, Ollama, or vLLM: **PASS**, AST-enforced.
- Provider identifier and configuration validation: **PASS**, including cross-field generation
  defaults.
- Prompt, completion, token content, model identifier, provider configuration, and reasoning logs:
  **PASS**, excluded and covered by negative disclosure tests.
- Raw exception/provider URL/credential exposure: **PASS**, fixed safe errors and allowlisted logs.
- High-confidence secret and credential-assignment scan: **PASS**, no matches.
- Outbound/provider imports in AI-service source: **PASS**, no matches.
- Existing request correlation and privacy policy: **PASS**, preserved.

## 13. Actual test commands and results

| Command                                                        | Result                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm.cmd check`                                               | **PASS**: Prettier, ESLint, TypeScript, JS tests/e2e, builds, Ruff, mypy, pytest |
| `pnpm.cmd check:python`                                        | **PASS**: Ruff lint/format, strict mypy, 81/81 pytest                            |
| `pnpm.cmd --filter @mm-ai/web test`                            | **PASS**: 3/3 direct, not Turbo cache                                            |
| `pnpm.cmd --filter @mm-ai/api test`                            | **PASS**: 8/8 direct, not Turbo cache                                            |
| `pnpm.cmd --filter @mm-ai/api test:e2e`                        | **PASS**: 2/2                                                                    |
| Python architecture tests                                      | **PASS**: 3/3 within pytest                                                      |
| `python -m pip check`                                          | **PASS**: no broken requirements                                                 |
| Python lock dry-run                                            | **PASS**: every exact-pinned requirement already satisfied                       |
| `pnpm.cmd install --frozen-lockfile --lockfile-only --offline` | **PASS**, no reinstall                                                           |
| `git diff --check`                                             | **PASS**, no whitespace errors                                                   |
| Sensitive-content scans                                        | **PASS**, no high-confidence matches                                             |

The Next.js build retains the existing Node 26 `module.register()` deprecation warning; compilation
and all build tasks pass.

## 14. Before/after test counts

| Suite          | Before 2.3 | After 2.3 |
| -------------- | ---------: | --------: |
| Web            |          3 |         3 |
| NestJS unit    |          8 |         8 |
| NestJS e2e     |          2 |         2 |
| FastAPI/Python |         24 |        81 |
| **Total**      |     **37** |    **94** |

The 57 new Python tests cover contracts, registration, selection, gateway defaults, capabilities,
errors, privacy, timeout, concurrency, cancellation, streaming, configuration, architecture, and
readiness compatibility.

## 15. Dependency audit results

- JavaScript: `pnpm.cmd audit --audit-level moderate` — **PASS**, no known vulnerabilities.
- Python: `pnpm.cmd audit:python` — **PASS**, no known vulnerabilities.
- Python consistency: `python -m pip check` and exact-lock dry-run — **PASS**.
- pnpm frozen/offline lock consistency — **PASS**.

The first sandboxed registry attempts were network-blocked and then rerun successfully with approved
npm/PyPI access. The existing pip-audit warning remains: versions are exact-pinned but Python
distribution hashes are absent.

## 16. Known issues

There is no blocking in-scope defect. Non-blocking limitations are intentional: no real provider,
inference integration, chat/SSE endpoint, prompt management, memory, RAG, embeddings, database,
queue, agent workflow, authentication, or external telemetry. Linux and remote GitHub Actions were
**NOT RUN** locally. Python dependency artifacts are not hash-locked. No actual Ollama integration
test was run, by explicit scope constraint.

## 17. Git status

Branch `main` remains based on `03ed5da` and ahead of `origin/main` by one pre-existing commit. The
working tree contains only reviewed Checkpoint 2.3 source, tests, configuration examples, and
documentation. No manifest or lockfile content changed. No commit, push, reset, clean, or unrelated
process action was performed. `git diff --check` passes; Windows emits informational LF-to-CRLF
normalization warnings.

## 18. Recommendation for Checkpoint 2.4

**PASS Checkpoint 2.3.** After human review and an authorized commit, Checkpoint 2.4 may implement one
loopback-only Ollama infrastructure adapter against `LLMProvider`, with adapter conformance tests,
strict transport timeouts, capability mapping, safe error translation, and opt-in integration tests.
It should not alter domain/application contracts unless a demonstrated provider-neutral requirement
is missing, and it must not add RAG, agents, public chat transport, or external inference implicitly.
