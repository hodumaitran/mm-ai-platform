# Checkpoint 2.4: Enterprise Ollama provider adapter and real local inference

- Final verification date: 2026-11-25
- Baseline: `9914194` (`feat(ai-service): implement model-neutral llm gateway`)
- Status: **PASS**
- Provider: Ollama `0.40.16` at `http://127.0.0.1:11434`
- Model: `qwen3.5:35b` (`c2ee66a3c0d6`)

## 1. Executive summary

Checkpoint 2.4 is accepted locally. The existing implementation was preserved and revalidated after
the operator restored the already-present model manifest and eight verified blobs. No model was
downloaded, deleted, or modified during acceptance. The active Ollama inventory and API now report
the expected 22 GB Q4_K_M model.

The provider adapter and model-neutral gateway passed real Vietnamese and English inference,
thinking disabled/enabled, token usage and finish-reason normalization, NDJSON streaming, timeout,
cancellation, concurrency-one, invalid-model, and readiness checks. The full quality gate, 118
Python cases across default and opt-in runs, 13 JavaScript cases, dependency consistency checks,
security audits, sensitive-content scans, and five HTTP smoke contracts pass.

## 2. Recovered baseline and model evidence

Checkpoint 2.3 remains commit `9914194`; local tag `checkpoint-2.3` points to it and
`checkpoint-2.2` remains `03ed5da`. Checkpoint 2.4 work is intentionally uncommitted.

Operator-provided recovery evidence records that the original manifest and all eight referenced
blobs were found on C:, each source and destination passed SHA-256 and size verification, the blobs
were copied to `D:\AI\Models\Ollama`, the manifest was restored, originals were preserved, and no
download occurred. This acceptance independently revalidated the resulting runtime state:

- `ollama list`: `qwen3.5:35b`, ID `c2ee66a3c0d6`, size 22 GB;
- `/api/tags`: digest
  `c2ee66a3c0d69da15478d396c6d0f4a52cfc596464ba6858d7ab85c556b174cc`, size
  `22069593934` bytes;
- `/api/show`: architecture `qwen35moe`, 34.7B parameters, Q4_K_M, context 262144;
- capabilities: completion, vision, tools, and thinking; thinking accepts false/true and defaults
  to true; license Apache 2.0.

## 3. Adapter architecture

`infrastructure/ollama.py` is the only Ollama-aware source module. It depends inward on application
readiness and provider-neutral domain contracts. Domain and gateway layers contain no Ollama schema,
endpoint, model name, or SDK dependency. The composition root registers and lifespan-owns the
adapter only when `AI_SERVICE_LLM_PROVIDER=ollama`; factory construction performs no network call.

The gateway owns provider selection, validated generation defaults, an end-to-end bounded deadline,
concurrency enforcement, cancellation, and response validation. The adapter is bound to one
configured model and cannot select arbitrary installed or cloud models.

## 4. Configuration, lifecycle, and resources

Accepted inference settings were model `qwen3.5:35b`, context 4096, temperature 0.2, maximum
concurrency 1, bounded output, and explicit deadlines up to 300 seconds for the heavyweight live
suite. Runtime defaults remain documented in `.env.example`.

The default origin is loopback. Validation rejects HTTPS/cloud origins, public or arbitrary
hostnames, credentials, paths, queries, fragments, and missing ports. The explicit `private` policy
only permits a literal private IP in production.

One pooled `httpx.AsyncClient` is created by `start()` and closed by `stop()`. It has bounded
connect/read/write/pool timeouts, two maximum connections, one keep-alive connection, redirects
disabled, and `trust_env=False`. Startup and cleanup tests pass.

## 5. Request and response mapping

- Neutral chat messages map to Ollama `{role, content}` messages.
- Temperature, output, context, and stop limits map to `temperature`, `num_predict`, `num_ctx`, and
  `stop`.
- Thinking enabled/disabled maps to `think: true/false`; default omits the field.
- Non-streaming uses `/api/chat` with `stream: false`; streaming consumes real NDJSON.
- `prompt_eval_count` and `eval_count` map to normalized usage; total is derived when both exist.
- `stop`, length, tool, and unknown finish reasons map to the provider-neutral taxonomy.
- `message.thinking` is discarded and never returned or logged.

The first thinking-enabled acceptance attempt used 64 output tokens. The model consumed that bound
entirely in private reasoning and returned empty final content; the adapter correctly rejected the
invalid completion without exposing reasoning. The acceptance bound was raised to 256 tokens, after
which a four-character final answer was normalized successfully. This was test calibration, not a
runtime contract change.

## 6. Capabilities and readiness

`/api/show` dynamically enables chat/streaming and thinking, while tool calling and structured output
remain false because those contracts are not implemented. Effective context is the smaller of the
configured 4096 policy and discovered 262144 model context.

`/health` is process-only. `/ready` performs bounded cached version, inventory, and model-detail
metadata probes; it does not infer, load a model, or claim RAG/agent capability. Accepted body:

```json
{
  "service": "ai-service",
  "status": "ready",
  "capabilities": { "configuration": true, "ollama": true, "model": true, "inference": true },
  "environment": "development"
}
```

Here `inference=true` means the exact configured model and required completion contract are
available. It does not advertise unsupported inference features.

## 7. Real inference results

The accepted opt-in suite ran all heavyweight calls sequentially except its controlled two-request
concurrency check: **9/9 PASS** in 10.58 seconds with the model already warm.

| Check                         | Actual result                                                         |
| ----------------------------- | --------------------------------------------------------------------- |
| Connectivity/version          | **PASS**, Ollama `0.40.16`                                            |
| Inventory/details/readiness   | **PASS**, exact model and capabilities                                |
| Invalid model                 | **PASS**, `MODEL_UNAVAILABLE`, no pull                                |
| Unavailable endpoint          | **PASS**, normalized connection error                                 |
| Vietnamese, thinking disabled | **PASS**, 0.4864 s, usage 25/3, `stop`, six-character final answer    |
| English, thinking enabled     | **PASS**, 5.4298 s, usage 23/211, `stop`, four-character final answer |
| Token/finish normalization    | **PASS** for both real completions                                    |
| Real NDJSON stream            | **PASS**, 24 content events, usage 23/25, `stop`                      |
| Timeout/cancellation          | **PASS**                                                              |
| Concurrency maximum 1         | **PASS**, observed delegate maximum 1                                 |

Only counts, timings, finish reasons, and safe final-answer characteristics are recorded. No private
reasoning trace is included in this report or application logs.

## 8. Streaming, timeout, cancellation, and concurrency

The accepted real stream completed in 0.7836 seconds; time to first content token was 0.1172 seconds.
It produced a typed start event, 24 non-empty content deltas, normalized usage, and one terminal event.

The 1 ms gateway deadline normalized to `PROVIDER_TIMEOUT`. Explicit task cancellation propagated
through gateway, adapter, and HTTP request. Ollama's local server log independently recorded
`stop: cancel task` for acceptance task IDs 558 and 559; one corresponds to the deadline and one to
explicit cancellation. This verifies provider-side workload termination. Ollama exposes no public
per-request job-status API, so server log evidence is the available provider-side observation.

The controlled concurrent pair completed with the counting delegate's maximum active call equal to
one, proving gateway queuing and semaphore release under the live provider.

## 9. Performance observations

These are single local observations, not capacity benchmarks:

- Hardware baseline: NVIDIA GeForce RTX 3060, 12288 MiB VRAM; 31.82 GiB physical RAM.
- Pre-load state: model absent from `ollama ps`, 752 MiB VRAM used, 22.04 GiB RAM available.
- Cold completion: 176.8538 seconds end-to-end, usage 25/3, finish `stop`.
- Warm Vietnamese completion: 0.4864 seconds end-to-end.
- Warm thinking-enabled completion: 5.4298 seconds end-to-end.
- Warm streaming: 0.7836 seconds total; TTFT 0.1172 seconds.
- Supplemental local Ollama timing with thinking disabled: 1.0056 seconds wall, 0.0016 seconds load,
  0.3032 seconds prompt evaluation, 0.5926 seconds generation, usage 23/24, and 40.4989 generated
  tokens/second.
- Observed cold-load samples: maximum 9481 MiB VRAM used, 18% GPU utilization, 56 °C, 21.37 GiB
  system RAM used, and 10.5% total CPU. These are sampled values and may not be absolute peaks.

## 10. Regression and test counts

- Default Python run: **109 PASS, 9 SKIP** (the skips are the explicit live opt-in cases).
- Opt-in live Python run: **9 PASS, 0 SKIP, 0 FAIL**.
- Distinct Python cases accepted across both modes: **118/118**.
- JavaScript: web 3, NestJS unit 8, NestJS e2e 2: **13/13 PASS**.
- Total distinct automated cases: **131/131 PASS**.
- Ollama adapter unit tests: 19 PASS within the default Python suite.

## 11. Quality gates and dependency audits

| Command/check                                          | Result                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm.cmd check`                                       | **PASS**: Prettier, ESLint, TS, JS/e2e/build, Ruff, strict mypy, pytest |
| Live pytest with `AI_SERVICE_RUN_OLLAMA_INTEGRATION=1` | **PASS**, 9/9                                                           |
| `python -m pip check`                                  | **PASS**, no broken requirements                                        |
| Python exact-lock no-index dry-run                     | **PASS**, every exact version already satisfied                         |
| pnpm lock-only frozen/offline check                    | **PASS**, no lock change                                                |
| `pnpm.cmd audit --audit-level high`                    | **PASS**, no known vulnerabilities                                      |
| `pnpm.cmd audit:python`                                | **PASS**, no known vulnerabilities                                      |
| Sensitive/private/model-weight scan                    | **PASS**, no findings                                                   |
| `git diff --check`                                     | **PASS**, no whitespace errors; Windows line-ending notices only        |
| HTTP smoke contracts                                   | **PASS**, 5/5                                                           |

A normal offline `pnpm install` probe stopped before mutation because pnpm wanted to purge the
existing modules directory in a non-TTY session. It was not forced and no reinstall occurred. The
non-mutating `--lockfile-only --frozen-lockfile --offline` validation then passed.

## 12. HTTP smoke results

| Endpoint                              | Status | Actual body/contract                     | Latency |
| ------------------------------------- | -----: | ---------------------------------------- | ------: |
| `http://127.0.0.1:3000`               |    200 | HTML contains `MM AI Platform`           | 16.1 ms |
| `http://127.0.0.1:3000/api/health`    |    200 | `{"service":"web","status":"ok"}`        | 10.9 ms |
| `http://127.0.0.1:3001/api/v1/health` |    200 | `{"service":"api","status":"ok"}`        |  9.2 ms |
| `http://127.0.0.1:8000/health`        |    200 | `{"service":"ai-service","status":"ok"}` |  9.4 ms |
| `http://127.0.0.1:8000/ready`         |    200 | ready body shown in section 6            |  9.3 ms |

Only the three created web/API/AI-service processes were stopped. Ports 3000, 3001, and 8000 had no
remaining listeners. The pre-existing loopback Ollama process was not stopped or reconfigured.

## 13. Security and privacy review

- Ollama remained at loopback `127.0.0.1:11434`: **PASS**.
- External/cloud AI fallback and authorization headers: **NOT IMPLEMENTED**.
- Model pull/download/delete/create: **NOT PERFORMED** and not implemented by the adapter.
- Proxy use and redirects: **DISABLED**.
- Prompt, completion, provider payload, and reasoning logging: **NOT IMPLEMENTED**; negative tests
  pass.
- Public errors use fixed safe taxonomy; raw provider errors and URLs are not exposed: **PASS**.
- Credential assignment/private key scan: **PASS**. The only credential-like test value is a fake
  URL proving credentials are rejected.
- Tracked private data/model weights: **NONE**.
- Security audits: **PASS**, no known JavaScript or Python dependency vulnerabilities.

## 14. Defects and limitations

No confirmed production-code defect remained after real-model verification. The acceptance test's
64-token thinking bound was insufficient for this model and was raised to a still-bounded 256. The
first smoke invocation used the wrong ASGI symbol; all created processes were cleaned up and the
documented factory entrypoint passed on rerun.

Remaining limitations:

- Python dependencies are exact-version pinned but do not contain artifact hashes.
- Linux and remote CI are **NOT RUN**.
- Performance numbers are local single samples, not load or capacity benchmarks.
- Ollama has no public per-request active-job endpoint; cancellation proof relies on its server log.
- Public chat/SSE endpoints, RAG, embeddings, agents, databases, authentication, cloud models, and
  external telemetry are out of scope and **NOT IMPLEMENTED**.

## 15. Git status and change control

Baseline `9914194` and tags `checkpoint-2.3`/`checkpoint-2.2` remain unchanged. Branch `main` remains
ahead of `origin/main` by the previously established local commits. Checkpoint 2.4 source, tests,
ADR, architecture documentation, and this report remain uncommitted as required. Nothing was pushed;
no history, global environment, model weight, C-drive original, or D-drive model file was changed by
this acceptance continuation.

## 16. Final acceptance decision

**PASS.** All mandatory Checkpoint 2.4 criteria are satisfied locally: real model inventory and
readiness, model-neutral adapter/gateway behavior, bounded complete and streaming inference,
thinking privacy, usage/finish normalization, timeout, provider-side cancellation, concurrency-one,
failure normalization, regression gates, audits, scans, and process smoke contracts. Stop at
Checkpoint 2.4; Checkpoint 2.5 has not started.
