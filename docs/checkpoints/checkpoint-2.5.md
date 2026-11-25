# Checkpoint 2.5 acceptance report

Date: 2026-11-25  
Final local verdict: **PASS**

## 1. Executive summary

Checkpoint 2.5 implements and locally accepts the versioned model-neutral Chat Completion API and
end-to-end SSE transport across the approved path:

```text
Client -> Next.js -> NestJS -> FastAPI -> LLM Gateway -> Ollama adapter -> qwen3.5:35b
```

The latest artifacts returned synchronous HTTP 200, delivered actual incremental SSE, propagated
client cancellation to new Ollama `cancel task` log entries, enforced one active plus one pending
inference, rejected overload and model overrides, preserved bounded deadlines, and recovered after
cancellation. Quality gates, 158 deterministic tests, and 9 live Ollama tests pass. This is a local
development acceptance only; it does not imply production readiness or remote CI success.

## 2. Authorization, baseline, and preflight

The user explicitly authorized temporary loopback services on ports 3000, 3001, and 8000, controlled
inference against the existing Ollama instance, local log inspection, and cleanup of only processes
created by acceptance.

| Item                      | Verified result                                                            |
| ------------------------- | -------------------------------------------------------------------------- |
| Branch / HEAD             | `main` / `f04e4abc04bcbe78f29448c94eeb27e7ef110085`                        |
| HEAD subject              | `feat(ai-service): integrate ollama provider and validate local inference` |
| `checkpoint-2.4^{commit}` | `f04e4abc04bcbe78f29448c94eeb27e7ef110085`                                 |
| Ollama                    | `0.40.16`, existing PID 3388, `127.0.0.1:11434`                            |
| Model                     | `qwen3.5:35b`, ID `c2ee66a3c0d6`, 34.7B, Q4_K_M                            |
| GPU before services       | RTX 3060; 754/12,288 MiB VRAM used                                         |
| RAM before services       | 31.82 GiB total; 21.11 GiB free                                            |
| Free disk                 | C: 238.59 GiB; D: 381.48 GiB                                               |
| Ports before start        | 3000/3001/8000 free; only Ollama on 11434                                  |

The baseline and existing Checkpoint 2.5 work were preserved. No reset, clean, stash, dependency
reinstall, model change, global environment change, commit, push, or tag mutation occurred.

## 3. Artifact freshness and runtime exposure

`pnpm.cmd build` completed from the current worktree. The NestJS compiled artifact contained
`@HttpCode(200)` and invalid-deadline rejection, and its relevant generated files were newer than
their sources. Next.js emitted both chat routes as dynamic server routes. The actual entrypoints were
`node dist/main.js`, `next start --hostname 127.0.0.1 --port 3000`, and the FastAPI application
factory via `python -m mm_ai_service`.

Runtime listener inspection confirmed:

| Service | Listener          |
| ------- | ----------------- |
| Next.js | `127.0.0.1:3000`  |
| NestJS  | `127.0.0.1:3001`  |
| FastAPI | `127.0.0.1:8000`  |
| Ollama  | `127.0.0.1:11434` |

No service listened on a wildcard or non-loopback address.

## 4. Architecture and contracts

Next.js owns the same-origin browser boundary and keeps `API_BASE_URL` server-only. NestJS owns the
business API and a typed, provider-neutral AI-service client. FastAPI maps strict public DTOs to the
existing `LLMGateway`; the lifecycle-owned Ollama adapter remains the only provider-specific layer.

Public routes:

- `POST /api/v1/chat/completions`
- `POST /api/v1/chat/completions/stream`

Contracts allow alternating `user` and `assistant` messages beginning and ending with `user`, finite
temperature 0-2, output up to 1,024 tokens, and explicit thinking `disabled`/`enabled`. They reject
unknown fields, system/tool injection, model/provider/URL overrides, more than 16 messages, more than
2,048 characters per message, more than 3,072 aggregate input characters, and bodies above 65,536
bytes. The configured context is 4,096. No raw Ollama response or reasoning trace crosses the API.

## 5. Synchronous full-chain evidence

All requests below entered at the Next.js endpoint and traversed the complete chain.

| Scenario                      | Result                                                                    |
| ----------------------------- | ------------------------------------------------------------------------- |
| Vietnamese, thinking disabled | **PASS**, HTTP 200, 176.7455 s cold, usage 27/6/33, `stop`                |
| English, thinking enabled     | **PASS**, HTTP 200, 12.6464 s warm, usage 21/480/501, `stop`              |
| Correlation                   | **PASS**, response header and body matched supplied sanitized request IDs |
| Schema/model/role             | **PASS**, version `1`, `qwen3.5:35b`, assistant role                      |
| Reasoning suppression         | **PASS**, no reasoning/thinking-content field                             |

An initial thinking-enabled request with only 384 output tokens exhausted its reasoning budget and
returned a safe 502 because no final content existed. It was correctly identified as budget
exhaustion, not transport failure; the approved 1,024-token retry passed. No raw provider data leaked.

## 6. Real SSE evidence

The final full-chain stream returned HTTP 200 and `text/event-stream; charset=utf-8`. Response headers
arrived at 519.125 ms; the first content event arrived at 521.226 ms. A total of 111 content events
arrived incrementally through 3,278.980 ms, and the stream completed at 3,311.861 ms. Independent
transport chunks arrived throughout the interval, proving the proxies did not buffer the full
response.

Event order was one `stream.started`, 111 `content.delta` events, then one `stream.completed`.
There was exactly one terminal event, no content after it, valid Vietnamese UTF-8, finish reason
`stop`, and usage 31/111/142. No reasoning field was present. Provider generation rate for this
sample is approximately 39.8 completion tokens/s over the content-generation interval; it is a local
observation, not an SLA.

## 7. Cancellation and provider-side proof

The acceptance client was a programmatic Node HTTP client at the Next.js boundary, not an interactive
browser. It tested the same HTTP disconnect path without claiming browser UI verification.

| Scenario                                     | Client/application evidence                    | New Ollama evidence                         |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| Before first content                         | only `stream.started`; abort call 22.045 ms    | `stop: cancel task`, task 988               |
| During active content                        | start plus first content; abort call 13.548 ms | `stop: cancel task`, task 994               |
| Deadline 20 ms                               | NestJS returned 504 in 36.392 ms               | `stop: cancel task`, task 1004              |
| Pending admission disconnect after final fix | pending request never reached provider         | only active cancellation plus recovery POST |

A subsequent full-chain inference returned HTTP 200 in 0.4906 s, proving capacity and transport
resources were reusable. Timers, listeners, response readers, async generators, HTTP bodies, and the
gateway permit are closed in cleanup paths.

## 8. Deadline, timeout, concurrency, and admission

| Policy                    | Value / evidence                                      |
| ------------------------- | ----------------------------------------------------- |
| Connect timeout           | 5 s                                                   |
| Admission timeout         | 30 s; deterministic PASS                              |
| First-content timeout     | 240 s; deterministic PASS                             |
| Stream inactivity timeout | 30 s; deterministic PASS                              |
| Total deadline            | 300 s; deterministic and real 20 ms cancellation PASS |
| Invalid deadline          | 400 in 98.13 ms; no upstream request                  |
| Active inference          | 1                                                     |
| Pending inference         | 1                                                     |

In the controlled full-chain test, one stream occupied the active slot, one completion occupied the
pending slot, and a third request received safe 503 overload in 10.665 ms. The pending socket was
then disconnected. After the final disconnect fix, Ollama recorded only two POSTs: the active request
that was cancelled and the successful recovery request; the pending request never entered provider
execution. Recovery returned 200 in 196.404 ms. No retry was observed.

## 9. Health, readiness, invalid model, and HTTP smoke

| Endpoint/scenario          | Result                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| Next.js `/`                | **PASS**, 200 HTML                                               |
| Next.js `/api/health`      | **PASS**, `{"service":"web","status":"ok"}`                      |
| NestJS `/api/v1/health`    | **PASS**, `{"service":"api","status":"ok"}`                      |
| FastAPI `/health`          | **PASS**, `{"service":"ai-service","status":"ok"}`               |
| FastAPI `/ready`           | **PASS**, provider/model/inference-compatible true               |
| Chat completion            | **PASS**, current artifact HTTP 200                              |
| SSE endpoint               | **PASS**, incremental current-artifact stream                    |
| External model override    | **PASS**, 400 with no provider detail leak                       |
| Internal unavailable model | **PASS**, live suite normalized `MODEL_UNAVAILABLE` without pull |

Readiness means provider reachable, model inventoried, and contract-compatible; it does not claim the
model is currently loaded and does not perform inference or warm-up.

## 10. Security and privacy

- **PASS**: all runtime listeners were loopback-only.
- **PASS**: private origins are credential-free server configuration; no `NEXT_PUBLIC` service URL.
- **PASS**: no external provider, fallback, automatic retry, or automatic model pull.
- **PASS**: strict DTOs and bounded bodies, input, output, response parsing, admission, and deadlines.
- **PASS**: model override and arbitrary upstream URL selection are rejected.
- **PASS**: observed AI logs contained request IDs, timings, usage, routes, status, and outcome only;
  no prompt, completion, reasoning trace, header, raw frame, secret, or private URL was logged.
- **PASS**: safe error responses did not expose Ollama errors or internal origins.
- **PASS**: source scan found no credential/private-key pattern, model weight, private dataset, or
  changed file above 1 MiB.
- **NOT IMPLEMENTED**: authentication and RBAC. Routes remain local-development-only and must not be
  exposed publicly.

## 11. Defects found and fixed

1. Added bounded one-active/one-pending admission and distinct overload/admission timeout behavior.
2. Added first-content, inactivity, and total timeout categories with cleanup.
3. Fixed NestJS synchronous status from 201 to 200.
4. Invalid direct NestJS deadlines now return 400 rather than resetting the budget.
5. NestJS synchronous completion now listens to response close as well as request abort.
6. Live concurrency testing found that a disconnected JSON route could remain queued inside FastAPI.
   FastAPI now races pre-header operations against ASGI `http.disconnect`, cancels and awaits the
   gateway operation, and closes a pre-header stream generator. Regression tests cover cleanup.
7. Disconnect presentation is normalized to `REQUEST_CANCELLED` (499) after internal task
   cancellation, avoiding an erroneous 500/stack trace for a closed peer.
8. New architecture documents were formatted and stale gateway documentation was corrected.

## 12. Final regression and audit results

Final `pnpm.cmd check`: **PASS**.

| Gate                            | Result                    |
| ------------------------------- | ------------------------- |
| Prettier / ESLint / TypeScript  | **PASS**                  |
| Next.js tests                   | **PASS**, 7/7             |
| NestJS unit                     | **PASS**, 12/12           |
| NestJS e2e                      | **PASS**, 13/13           |
| Next.js and NestJS builds       | **PASS**                  |
| Ruff format/lint                | **PASS**, 43 Python files |
| Strict mypy                     | **PASS**, 43 Python files |
| Python deterministic tests      | **PASS**, 126/126         |
| Live Ollama suite on final code | **PASS**, 9/9 in 9.87 s   |

Distinct deterministic count: **158 PASS** (126 Python + 32 JavaScript), 0 failed. Live Ollama tests
are reported separately and repeated development runs are not double-counted.

Final live-suite observations: connectivity 0.2353 s; warm Vietnamese 0.5941 s with usage 25/3;
warm thinking-enabled English 4.3599 s with usage 23/164 and 37.6152 generated tokens/s; streaming
0.8835 s total, TTFT 0.2558 s, usage 23/24, and 23 content events. The full-chain cold observation
was 176.7455 s; a later naturally cold stream took approximately 180 s before start. During the
acceptance workload, a sample showed 11,043 MiB VRAM used, 22.58 GiB RAM used, GPU 5%, and 53 C.

Dependency and repository gates:

- `pip check`: **PASS**, no broken requirements.
- Python vulnerability audit: **PASS**, no known vulnerabilities.
- JavaScript vulnerability audit: **PASS**, no known vulnerabilities.
- Secret/private-key/dataset/model-weight scan: **PASS**.
- `git diff --check`: **PASS**; Windows LF/CRLF notices are informational.
- No dependency or lockfile change.

## 13. Cleanup, Git status, and limitations

Only the temporary Next.js, NestJS, and FastAPI processes created for acceptance were stopped.
Listeners 3000, 3001, and 8000 were removed. The pre-existing Ollama process PID 3388 and its
loopback listener remained running. The temporary acceptance client file was deleted.

The worktree remains intentionally dirty with Checkpoint 2.5 source, tests, and documentation. HEAD
and `checkpoint-2.4` remain unchanged on the accepted baseline. Nothing is staged; no commit, push,
or tag operation was performed.

Known limitations:

- Authentication, RBAC, identity-aware throttling, and production network policy are absent.
- Admission is process-local, not distributed across replicas.
- There is no durable queue, resume, automatic SSE reconnect, or request replay.
- No startup warm-up is performed; cold loading can consume roughly 177-180 seconds.
- Linux and remote CI are **NOT RUN** for this uncommitted checkpoint.

## 14. Final decision

**PASS for local Checkpoint 2.5 acceptance.** All mandatory local criteria now have current evidence,
and no confirmed unresolved Critical or High defect remains. This PASS does not authorize production
deployment and does not imply remote CI success. Stop here; Checkpoint 2.6 requires separate human
review and authorization.
