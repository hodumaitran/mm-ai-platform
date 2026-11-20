# Checkpoint 2.1.1: Foundation architecture, code quality and security audit

- Date: 2026-11-20
- Scope: independent audit and in-scope remediation of Checkpoint 2.1
- Recommendation: **CONDITIONAL APPROVAL**

## 1. Executive result

The implemented service boundaries and monorepo foundation are appropriate for the current scope.
All locally executable quality gates, production builds, dependency audits and HTTP smoke tests pass
after remediation. No LLM gateway, provider adapter, RAG, authentication, database or agent feature
was added.

Approval remains conditional because remote GitHub Actions have not run, Linux behavior is configured
but not executed locally, Git staging dry-run is blocked by the managed read-only `.git` directory,
and the Python lock pins versions but does not contain artifact hashes.

## 2. Architecture review

| Area                    | Result  | Evidence                                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------- |
| pnpm workspace          | PASS    | Only the two JavaScript applications are workspace packages                                 |
| Turborepo               | PASS    | Build depends on upstream builds; dev is persistent/non-cacheable; quality tasks cache logs |
| Service boundaries      | PASS    | Browser → NestJS → FastAPI → future provider remains documented and enforced                |
| TypeScript strictness   | PASS    | Shared strict mode plus typed ESLint and successful typecheck                               |
| Python strictness       | PASS    | mypy strict and Ruff both pass                                                              |
| Configuration ownership | PASS    | Each service validates only its own settings; unused web host/port variables removed        |
| Production builds       | PASS    | Next.js and NestJS production builds pass; `next start` is smoke-tested                     |
| Reproducibility         | PARTIAL | JS frozen lock passes; Python versions are fully pinned but not hash-pinned                 |
| Windows portability     | PASS    | `.cmd` and PowerShell workflows execute locally                                             |
| Linux portability       | PARTIAL | Bash scripts and CI matrix exist; no Linux runner was executed in this audit                |
| Documentation alignment | PASS    | README, ADRs, boundaries, security baseline and AGENTS rules remain aligned                 |

No premature shared packages, provider abstractions or infrastructure placeholders were introduced.

## 3. Findings and remediation

| ID   | Severity      | Finding                                                                                                  | Resolution                                                                                  |
| ---- | ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| F-01 | HIGH          | PowerShell Python gate continued after Ruff/mypy failures and could return pytest's successful exit code | FIXED: every native command now propagates non-zero exit status                             |
| F-02 | MEDIUM        | FastAPI settings were lazy and the documented Uvicorn command bypassed validated host/port ownership     | FIXED: settings load fail-fast and `python -m mm_ai_service` starts from validated settings |
| F-03 | MEDIUM        | NestJS e2e setup diverged from production filters/pipes                                                  | FIXED: shared `configureApplication` is used by production and e2e bootstrap                |
| F-04 | MEDIUM        | NestJS error response echoed `request.url`, including query-string secrets                               | FIXED: response uses path only; e2e verifies a token query value is absent                  |
| F-05 | MEDIUM        | Web health test asserted a hand-written object rather than invoking the route                            | FIXED: test calls the actual route and validates status/body                                |
| F-06 | MEDIUM        | Python dependencies had no vulnerability audit gate                                                      | FIXED: pinned pip-audit tool, scripts and CI gate added                                     |
| F-07 | MEDIUM        | GitHub Actions used mutable major tags                                                                   | FIXED: third-party actions are pinned to full commit SHAs                                   |
| F-08 | LOW           | CI duplicated API e2e and only described Windows execution                                               | FIXED: duplicate removed; Windows/Linux matrices and platform scripts added                 |
| F-09 | LOW           | Global `*.bin` ignore could hide valid documentation or fixtures                                         | FIXED: broad rule removed; designated root model/private storage paths remain ignored       |
| F-10 | LOW           | Web host/port examples implied runtime ownership while scripts hardcoded the secure loopback binding     | FIXED: unused variables removed; scripts remain explicitly loopback-bound                   |
| F-11 | LOW           | Python requirements are exact-version pinned without distribution hashes                                 | OPEN: add cross-platform hashes with a controlled lock-generation tool before production    |
| F-12 | INFORMATIONAL | Next.js emits Node 26 `module.register()` deprecation warning during build                               | OPEN: build succeeds; track upstream compatibility                                          |

No CRITICAL finding remains. No HIGH or MEDIUM finding remains open.

## 4. Security review

- Environment validation: PASS for web URL, NestJS environment/host/port and FastAPI settings.
- Secret exposure and sensitive logging: PASS; no credential-like content found.
- Error disclosure: PASS; generic errors omit exception details and query strings.
- Default binding: PASS; application scripts default to `127.0.0.1`.
- Input validation: PASS for currently implemented configuration boundaries. There are no business DTO
  endpoints in this checkpoint.
- CORS: NOT IMPLEMENTED. NestJS CORS is intentionally disabled because no cross-origin browser flow is
  implemented yet.
- Authentication controls: NOT IMPLEMENTED (outside scope).
- Database controls: NOT IMPLEMENTED (outside scope).
- CI permissions: PASS; workflow has only `contents: read`.
- Action supply chain: PASS; all action references use immutable commit SHAs.
- Accidental external calls: PASS; application source contains only loopback service URLs. Dependency
  audits query public advisory/package metadata without uploading repository content.

## 5. Gitignore and staging safety

Synthetic path checks verified:

- `models/` and root `storage/` remain ignored as designated private/model locations.
- `packages/models/`, `apps/api/src/models/`, `docs/models/`, `docs/storage/` and
  `docs/checkpoints/model.bin` are not ignored.
- `.env` files are ignored while all `.env.example` files are not ignored.
- Private datasets, uploads, logs, databases, caches and build outputs remain ignored.

Sensitive-content inspection: PASS. Git staging dry-run: BLOCKED because the managed environment does
not permit creating `.git/index.lock`; no staging mutation occurred.

## 6. Testing quality

Assertions now cover implementation behavior rather than application startup alone:

- Web: 3 tests PASS — route contract, default API URL and invalid protocol.
- NestJS unit: 8 tests PASS — health contract and invalid/default environment configuration.
- NestJS e2e: 2 tests PASS — health endpoint and sanitized error contract.
- FastAPI: 8 tests PASS — liveness, exact readiness capabilities, invalid settings, fail-fast import and
  non-disclosing error response.
- Invalid business input: NOT IMPLEMENTED / not applicable because no business endpoint exists.

Readiness explicitly reports `ollama: false` and `inference: false`.

## 7. Quality gate evidence

| Command/gate                     | Result                       |
| -------------------------------- | ---------------------------- |
| `pnpm install --frozen-lockfile` | PASS                         |
| `pnpm check`                     | PASS                         |
| Prettier check                   | PASS                         |
| ESLint                           | PASS                         |
| TypeScript typecheck             | PASS                         |
| Next.js production build         | PASS                         |
| NestJS production build          | PASS                         |
| JavaScript unit tests            | PASS — 11 tests              |
| NestJS e2e                       | PASS — 2 tests               |
| Ruff lint/format                 | PASS                         |
| mypy strict                      | PASS                         |
| pytest                           | PASS — 8 tests               |
| HTTP smoke tests                 | PASS — 5/5 returned HTTP 200 |

The HTTP smoke test used production Next/Nest builds and the validated Python module entry point. Test
processes were stopped by their exact PIDs; ports 3000, 3001 and 8000 had no remaining listeners.

## 8. Dependency audits

- JavaScript: `pnpm audit --audit-level moderate` — PASS, no known vulnerabilities.
- Python: `pip-audit 2.10.1` against `requirements.lock` — PASS, no known vulnerabilities.
- pip-audit warns that exact pins should additionally include hashes. This is retained as F-11 rather
  than suppressing the warning.

## 9. CI/CD readiness

The workflow parses successfully and now:

- pins Node.js 26.13.0, Python 3.13.14 and pnpm 10.34.9;
- performs frozen pnpm installation;
- uses the pinned Python requirements lock;
- executes JavaScript and Python gates on Windows and Linux matrices;
- runs both dependency audits with failure propagation;
- pins every third-party action to an immutable SHA;
- grants read-only repository contents permission.

Local workflow configuration validation: PASS. Actual GitHub Actions execution: **NOT RUN**. Remote CI
must not be reported as passing until a workflow run exists.

## 10. Node.js runtime recommendation

Local development remains unchanged at Node.js 26.5.0. Production and CI should use the latest patched
Node.js 26 Active LTS release; CI is pinned to 26.13.0. No global runtime was modified.

## 11. Ollama environment status

Read-only verification result: PASS.

- Executable: `C:\Users\tran.ho\AppData\Local\Programs\Ollama\ollama.exe`
- Version: 0.40.16
- Listener: `127.0.0.1:11434`, process `ollama` PID 3352
- `/api/version`: responded with 0.40.16
- `/api/tags`: `qwen3.5:35b` present, reported size 22,069,592,181 bytes
- Inference/model loading: NOT RUN by design

No model, Ollama installation or system PATH was modified.

## 12. Git readiness

Git branch `main` has no commits and its configured remote tracking reference is absent. All foundation
files remain untracked because committing and staging were outside authorization. No commit or push was
performed. Source and ignore-rule review is PASS; final staging verification is BLOCKED by managed
`.git` permissions and must be repeated by the user before the first commit.

## 13. Recommendation

**CONDITIONAL APPROVAL** for Checkpoint 2.1.1.

Conditions before treating the foundation as remotely/production verified:

1. Review the first staging set in a normal Git environment and create an authorized initial commit.
2. Run the pinned GitHub Actions Windows/Linux matrix and retain evidence.
3. Generate and verify cross-platform hashes for the Python lock before production deployment.

Stop here. Checkpoint 2.2 is not authorized by this audit.
