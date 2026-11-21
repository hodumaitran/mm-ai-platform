# Checkpoint 2.2: Enterprise AI service architecture

- Date: 2026-11-20
- Baseline: `3ae38ed` (`feat: establish enterprise monorepo foundation`)
- Status: **PASS**
- Scope: internal FastAPI architecture and operational contracts; no inference integration

## 1. Executive summary

Checkpoint 2.2 is accepted locally. The AI service now uses an explicit application factory and four
internal layers: domain, application, infrastructure, and presentation. Lifecycle management,
machine-readable error responses, request correlation, context isolation, and privacy-safe local JSON
logging are implemented and tested. No LLM gateway, provider adapter, model loading, outbound
inference, RAG, database, authentication, or agent capability was added.

All locally required gates pass: root quality gate, 37 tests across the repository, dependency
consistency, JavaScript and Python vulnerability audits, secret-pattern inspection, diff validation,
and five production HTTP smoke endpoints.

## 2. Initial repository audit

The recovery audit read `AGENTS.md`, README, both earlier checkpoint reports, architecture/security
documents, all changed AI-service source and tests, Git status, and the complete changed-file set.
The foundation baseline was present and the working tree contained only the expected Checkpoint 2.2
changes. The required Checkpoint 2.2 acceptance report was the only missing deliverable.

Reusable strengths were the strict Pydantic configuration, loopback defaults, established health
contracts, strict Ruff/mypy/pytest gate, stable monorepo scripts, and provider-neutral service
boundary. The prior global FastAPI application/settings and minimal error handler were appropriately
replaced rather than wrapped with duplicate abstractions.

## 3. Architectural findings

The recovered implementation was structurally sound. Two confirmed defects were found and fixed:

1. Request-ID middleware decoded ASCII with `errors="ignore"`, which could remove unsafe bytes and
   accidentally accept the remaining value. It now decodes losslessly with Latin-1 so the ASCII
   allowlist rejects the complete unsafe value. Non-ASCII and overlength regression tests were added.
2. The application factory retained the caller's mutable resource sequence. It now captures a tuple
   at composition time, giving each application stable resource ownership. A mutation regression test
   was added.

No architectural rewrite was required.

## 4. Final AI service directory tree

```text
apps/ai-service/
  src/mm_ai_service/
    application/
      __init__.py
      lifecycle.py
      observability.py
      readiness.py
    domain/
      __init__.py
      errors.py
    infrastructure/
      __init__.py
      lifecycle.py
      logging.py
    presentation/
      __init__.py
      errors.py
      middleware.py
      request_context.py
      routes.py
    __init__.py
    __main__.py
    config.py
    main.py
  tests/
    test_architecture.py
    test_config.py
    test_errors.py
    test_factory_lifecycle.py
    test_health.py
    test_logging.py
    test_request_context.py
```

## 5. Layer responsibilities and dependency direction

- **Domain:** safe error taxonomy; no framework or outer-layer imports.
- **Application:** provider-neutral readiness behavior plus resource and event-logging ports; no
  FastAPI, Starlette, infrastructure, or presentation imports.
- **Infrastructure:** FastAPI lifespan adapter and local JSON logger; depends inward on application
  contracts and never on presentation.
- **Presentation:** routes, HTTP error mapping, request-ID validation, ASGI middleware, and request
  context; concrete technical services are injected.
- **Composition root:** `mm_ai_service.main:create_app` is the only place that wires settings,
  logging, lifecycle, middleware, handlers, and routes.

AST-based architecture tests enforce the meaningful import restrictions.

## 6. Architecture decisions

ADR 0003 records the factory, dependency injection without a framework, frozen settings, ordered
lifespan, `ContextVar` correlation, stable error codes, metadata allowlisting, and future LLM gateway
boundary. The Uvicorn module entry point uses factory mode. Factory construction performs no network
call, client initialization, or model loading.

Configuration precedence is explicit constructor input, process environment, service `.env`, then
declared defaults. Only currently consumed environment, host, port, and log-level values exist.

## 7. Created and modified files

The final change set contains 32 paths including this report:

- Modified foundation files: README, AI-service entry point/config/composition root, and three
  existing Python test modules.
- Replaced the former flat `errors.py` with domain and presentation error modules.
- Added 14 layer modules across application, domain, infrastructure, and presentation.
- Added four focused test modules for architecture, lifecycle/factory, logging, and request context.
- Added ADR 0003, three architecture documents, logging privacy policy, and this checkpoint report.

No manifest version or dependency lock content changed.

## 8. Implemented functionality

- Independent FastAPI instances from explicit dependencies.
- Stable ownership snapshot for injected managed resources.
- Deterministic startup, rollback, reverse shutdown, and aggregate shutdown failure reporting.
- Frozen validated settings with fail-fast invalid configuration.
- Error codes for invalid request, configuration error, unavailable capability, and internal error.
- Validated/generated `X-Request-ID` in normal and error responses.
- Async-safe request context with deterministic reset.
- Local JSON events with fixed base fields and allowlisted metadata.
- Preserved `/health` and `/ready` contracts without provider calls.

## 9. Application lifecycle behavior

Resources start in declaration order. If startup fails, only resources that completed startup are
stopped in reverse order and the original failure is re-raised. Normal shutdown attempts every stop
in reverse order; failures are collected and raised after all cleanup attempts. Production currently
injects no managed resources because no provider, database, or queue exists.

Lifecycle tests verify normal ordering, startup rollback, continued cleanup after stop failure, and
application-instance isolation.

## 10. Error handling and request correlation

All implemented error mappings return `{error: {code, message, request_id}}`. Validation errors use a
generic message; unexpected exception text is neither serialized nor logged. Request IDs accept only
1–64 ASCII letters, digits, `.`, `_`, and `-`. Missing, non-ASCII, overlength, or otherwise unsafe
values are replaced by a 32-character random hexadecimal value.

The request ID is stored in request state and a resettable `ContextVar`, returned through the response
header, and included in error bodies. Concurrent async requests were verified to retain distinct IDs
with no post-request context leakage.

## 11. Security and privacy review

- External AI APIs and outbound inference calls: **NOT IMPLEMENTED**.
- Ollama exposure/connectivity checks: **NOT IMPLEMENTED**; readiness reports false.
- Request metadata validation: **PASS**.
- Unsafe exception serialization: **PASS**; generic contracts only.
- Structured-log privacy: **PASS**; bodies, query strings, authorization headers, prompts, tokens,
  credentials, and exception messages are excluded.
- High-confidence secret-pattern inspection: **PASS**, no findings.
- External telemetry exporters: **NOT IMPLEMENTED**.
- Runtime/model changes: **NONE**.

## 12. Test commands and actual results

| Command                                                        | Result                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm.cmd check`                                               | **PASS**: formatting, ESLint, TS typecheck, JS tests/e2e, builds, Ruff, mypy, pytest |
| `pnpm.cmd check:python`                                        | **PASS**: Ruff lint/format, strict mypy, 24 pytest tests                             |
| `pnpm.cmd --filter @mm-ai/web test`                            | **PASS**: 3/3, executed directly                                                     |
| `pnpm.cmd --filter @mm-ai/api test`                            | **PASS**: 8/8, executed directly                                                     |
| `pnpm.cmd --filter @mm-ai/api test:e2e`                        | **PASS**: 2/2, executed directly                                                     |
| `python -m pip check`                                          | **PASS**: no broken requirements                                                     |
| `pnpm.cmd install --frozen-lockfile --lockfile-only --offline` | **PASS**: manifest/lock consistency, no reinstall                                    |
| `git diff --check`                                             | **PASS**: no whitespace errors                                                       |
| Sensitive-content pattern scan                                 | **PASS**: no high-confidence secret patterns                                         |

The Python suite includes unit-style contract tests, TestClient integration tests, AST architecture
tests, and an async ASGI concurrency test. Actual process execution is reported separately below.

## 13. Before/after test counts

| Suite          | Before 2.2 | After 2.2 |
| -------------- | ---------: | --------: |
| Web            |          3 |         3 |
| NestJS unit    |          8 |         8 |
| NestJS e2e     |          2 |         2 |
| FastAPI/Python |          8 |        24 |
| **Total**      |     **21** |    **37** |

All 37 current tests pass. Python gained 16 tests while preserving the earlier health and
configuration coverage.

## 14. HTTP smoke test results

Production Next.js and NestJS builds plus the validated Python module entry point were started on
loopback. Response bodies were parsed and asserted, not status-checked alone.

| URL                                   | Result        | Verified body contract                                                     |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| `http://127.0.0.1:3000`               | **PASS**, 200 | HTML contains `MM AI Platform`                                             |
| `http://127.0.0.1:3000/api/health`    | **PASS**, 200 | `{"service":"web","status":"ok"}`                                          |
| `http://127.0.0.1:3001/api/v1/health` | **PASS**, 200 | `{"service":"api","status":"ok"}`                                          |
| `http://127.0.0.1:8000/health`        | **PASS**, 200 | `{"service":"ai-service","status":"ok"}`                                   |
| `http://127.0.0.1:8000/ready`         | **PASS**, 200 | configuration true; Ollama false; inference false; development environment |

The AI responses also echoed the safe test request IDs. Only processes created by checkpoint
verification were stopped. Ports 3000, 3001, and 8000 had no remaining listeners afterward.

## 15. Dependency audit results

- JavaScript: `pnpm.cmd audit --audit-level moderate` — **PASS**, no known vulnerabilities.
- Python: `pnpm.cmd audit:python` — **PASS**, no known vulnerabilities.
- Python consistency: `python -m pip check` — **PASS**.

The first sandboxed audit attempts were network-blocked and were rerun successfully with explicitly
approved registry/PyPI access. The existing pip-audit warning remains: versions are exact-pinned but
the Python lock does not contain distribution hashes.

## 16. Known limitations

LLM gateway, Ollama/vLLM adapters, chat/streaming endpoints, prompt management, memory, PostgreSQL,
Redis, RAG, embeddings, vector storage, LangGraph, agents, authentication, RBAC, containers, and
external telemetry are intentionally absent. Local application events are structured JSON; Uvicorn
and framework startup/access logs retain their native formatting. The web test is not browser-level.

## 17. Blockers and technical debt

There is no blocking local Checkpoint 2.2 defect. Remaining non-blocking debt:

- Python pins are not artifact-hash locked.
- The GitHub Actions Windows/Linux matrix was **NOT RUN** in this local verification.
- Linux scripts were **NOT RUN** locally.
- Next.js still emits the known Node 26 `module.register()` deprecation warning during build.

## 18. Git status

Branch `main` is based on foundation commit `3ae38ed`. The working tree contains only the reviewed
Checkpoint 2.2 source, test, and documentation changes. No commit or push was performed. Final
`git diff --check` passed; Git emitted informational LF-to-CRLF normalization warnings on Windows.

## 19. Recommendation for Checkpoint 2.3

**PASS Checkpoint 2.2.** The local in-scope acceptance criteria are verified. Before starting
Checkpoint 2.3, review and create an authorized Checkpoint 2.2 commit, then run the remote Windows and
Linux CI matrix. Do not start provider or LLM gateway work implicitly; it requires the next explicit
checkpoint scope.
