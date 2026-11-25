# MM AI Platform

MM AI Platform is a private, self-hosted foundation for Vietnamese enterprise AI workflows at MM
Research. The architecture is model-agnostic and keeps the browser, business API, AI service, and
local inference provider behind explicit boundaries.

## Current scope

Checkpoint 2.5 adds a versioned Chat Completion API and end-to-end SSE transport while reusing the
lifecycle-managed Ollama adapter and model-neutral LLM Gateway. Browser requests remain same-origin
through the Next.js server boundary, NestJS remains the business API, and FastAPI owns inference
orchestration. Authentication, databases, RAG, agents, and a final chat UI remain intentionally
absent.

## Prerequisites

- Node.js 20.9 or newer (validated locally with Node.js 26.5.0)
- pnpm 10.x (the workspace pins 10.34.9)
- Python 3.13 and the existing `.venv`
- Git

Ollama is optional unless `AI_SERVICE_LLM_PROVIDER=ollama` is selected. `/health` never contacts it;
`/ready` performs bounded, cached metadata checks and never downloads or runs a model.

For production, use the latest patched Node.js 26 Active LTS release. The CI workflow currently pins
Node.js 26.13.0; the local development runtime remains unchanged at 26.5.0.

## Setup on Windows

PowerShell execution policy can block `pnpm.ps1`; use the `.cmd` shim without changing global policy.

```powershell
pnpm.cmd install --frozen-lockfile
.\.venv\Scripts\python.exe -m pip install -r .\apps\ai-service\requirements.lock
.\.venv\Scripts\python.exe -m pip install --no-deps -e .\apps\ai-service
Copy-Item apps\web\.env.example apps\web\.env.local
Copy-Item apps\api\.env.example apps\api\.env
Copy-Item apps\ai-service\.env.example apps\ai-service\.env
```

Example files are lowest-priority documentation. Local `.env` files override defaults and are never
committed. Process environment variables take precedence over service `.env` files. Each service owns
and validates only its own variables.

## Development

Start JavaScript services with `pnpm.cmd dev`. Start Python separately because Turborepo does not own
Python lifecycle tasks:

```powershell
pnpm.cmd dev
Set-Location apps\ai-service
..\..\.venv\Scripts\python.exe -m mm_ai_service
```

| Service            | URL                                   |  Port |
| ------------------ | ------------------------------------- | ----: |
| Web                | `http://127.0.0.1:3000`               |  3000 |
| NestJS API         | `http://127.0.0.1:3001/api/v1/health` |  3001 |
| FastAPI AI service | `http://127.0.0.1:8000/health`        |  8000 |
| Ollama             | `http://127.0.0.1:11434`              | 11434 |

Local development chat endpoints are:

- `POST http://127.0.0.1:3000/api/v1/chat/completions`
- `POST http://127.0.0.1:3000/api/v1/chat/completions/stream`

The web route uses server-only `API_BASE_URL`; no `NEXT_PUBLIC` service URL is accepted. These routes
have no authentication yet and must remain loopback-only until a later checkpoint adds production
access control.

## Quality commands

```powershell
pnpm.cmd format:check
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd --filter @mm-ai/api test:e2e
pnpm.cmd build
pnpm.cmd check:python
pnpm.cmd audit:python
pnpm.cmd check
```

On Linux, create `.venv`, install the same lockfile, and run the equivalent scripts:

```bash
python3.13 -m venv .venv
.venv/bin/python -m pip install -r apps/ai-service/requirements.lock
.venv/bin/python -m pip install --no-deps -e apps/ai-service
bash scripts/check-python.sh
bash scripts/audit-python.sh
```

The workflow file is configured for Windows and Linux, but remote GitHub Actions status must only be
reported after an actual workflow run.

## Troubleshooting

- If PowerShell reports script execution is disabled, use `pnpm.cmd`, not `pnpm`.
- If a port is occupied, identify its owner; do not terminate an unrelated process.
- Run Python commands through `.venv\Scripts\python.exe` to avoid global package drift.

## Known limitations

Authentication, RBAC, databases, RAG, vLLM adapters, a final chat UI, agents, containers, external
telemetry, and production deployment are not implemented. AI-service JSON
logs are local process output only and deliberately exclude request bodies, query strings, headers,
prompts, completions, reasoning traces, provider payloads, and secrets. Ollama models are never
downloaded automatically.

AI-service architecture details are documented in
[`docs/architecture/ai-service-architecture.md`](docs/architecture/ai-service-architecture.md).
