# MM AI Platform

MM AI Platform is a private, self-hosted foundation for Vietnamese enterprise AI workflows at MM
Research. The architecture is model-agnostic and keeps the browser, business API, AI service, and
local inference provider behind explicit boundaries.

## Current scope

Checkpoint 2.2 adds a layered, factory-built internal architecture to the FastAPI AI service with
deterministic lifecycle management, safe error contracts, request correlation, and local structured
logging. Authentication, databases, RAG, agents, chat completion, and provider integration are
intentionally not implemented.

## Prerequisites

- Node.js 20.9 or newer (validated locally with Node.js 26.5.0)
- pnpm 10.x (the workspace pins 10.34.9)
- Python 3.13 and the existing `.venv`
- Git

Ollama is not required for this checkpoint's service health checks.

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

| Service                     | URL                                   |  Port |
| --------------------------- | ------------------------------------- | ----: |
| Web                         | `http://127.0.0.1:3000`               |  3000 |
| NestJS API                  | `http://127.0.0.1:3001/api/v1/health` |  3001 |
| FastAPI AI service          | `http://127.0.0.1:8000/health`        |  8000 |
| Ollama (future integration) | `http://127.0.0.1:11434`              | 11434 |

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

Authentication, RBAC, databases, RAG, LLM gateway, Ollama integration, agents, containers, external
telemetry, and browser-level web tests are not implemented. AI-service JSON logs are local process
output only and deliberately exclude request bodies, query strings, headers, prompts, and secrets.

AI-service architecture details are documented in
[`docs/architecture/ai-service-architecture.md`](docs/architecture/ai-service-architecture.md).
