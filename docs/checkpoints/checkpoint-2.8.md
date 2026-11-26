# Checkpoint 2.8: Tool calling

## Phase A: Enterprise tool calling core

Status: **LOCAL PASS** (Linux and remote CI NOT RUN). Phase B has not been started.

### 1. Baseline

- HEAD `a496622` equals the peeled `checkpoint-2.7` tag; the working tree was clean before the work.
- Existing contracts reviewed: `domain/llm.py` (`MessageRole.TOOL`, `FinishReason.TOOL_CALL`,
  `ModelCapabilities.tool_calling`), gateway, `RequestDeadline`, `PromptService`, `ContextService`. The
  Ollama provider reports `tool_calling=False`, so no provider change was needed or made.

### 2. Architecture decisions

See `docs/adr/0009-tool-calling-core.md`: flat strict schemas, sealed registry, deployment allowlist
(default deny), bounded executor with no queue, reuse of `RequestDeadline`, shared timeout validation.

### 3. Implemented contracts and modules

| File                              | Content                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `domain/tools.py` (new)           | Definitions, parameters, call, result, metadata, bounds      |
| `domain/errors.py`                | 12 tool error types with fixed codes                         |
| `application/tools.py` (new)      | Sealed registry, execution policy, executor, `failed_result` |
| `application/demo_tools.py` (new) | `calculate`, `text_statistics`, `build_demo_registry()`      |
| `application/deadline.py`         | `validate_timeout_seconds` (finite, positive, not boolean)   |
| `application/gateway.py`          | `_deadline` now uses the shared validator                    |
| `infrastructure/logging.py`       | Allowlist: `tool_name`, `argument_count`, `result_chars`     |

The executor is not wired into `main.py` and there is no route, so the public API is unchanged.

### 4. Security and resource limits

Deny-by-default allowlist; unknown and unauthorized tools rejected; strict arguments (unknown, missing,
mistyped, out-of-range, nested, non-finite, oversized); depth 3, 64 nodes, collections 16, strings 4,096,
integers 2^53; results bounded (4,096 default, 16,384 hard cap); sanitized errors; content-free logs;
tool timeout plus shared request deadline; bounded concurrency without a queue; capacity released on
success, failure, timeout and cancellation. Details: `docs/architecture/tool-security.md`.

Defect found and fixed on the way: the gateway deadline check accepted NaN (and infinity, which was
silently capped). It now rejects both through `validate_timeout_seconds`.

### 5. Tests and gates (actual exit codes)

| Check                                    | Exit    | Result                                                                                              |
| ---------------------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `pytest` (full deterministic suite)      | 0       | 404 passed, 9 skipped (297 prior + 107 new)                                                         |
| New suite repeated 3 times               | 0, 0, 0 | stable                                                                                              |
| `ruff check` / `ruff format --check`     | 0, 0    | clean                                                                                               |
| `mypy` strict                            | 0       | 56 source files                                                                                     |
| `pnpm.cmd check`                         | 0       | includes the 404 passed Python run                                                                  |
| `prettier --check .`                     | 0       | after formatting the new docs                                                                       |
| `git diff --check`                       | 0       |                                                                                                     |
| Secret scan, changed and untracked files | 0       | no matches, no execution errors                                                                     |
| Dependency audits                        | NOT RUN | no manifest or lockfile changed; reuses the exit 0 / 0 evidence in `checkpoint-2.7.md` section 28.2 |
| Live Ollama                              | NOT RUN | not applicable: no provider or execution path changed                                               |

New tests (`tests/test_tool_calling.py`) cover registry immutability and duplicates, unknown and
unauthorized tools, default deny, strict and malformed arguments, depth, node, collection and string
limits, cycles, non-finite numbers, oversized results, successful execution, sanitized handler errors,
tool timeout versus request deadline, synchronous overrun, cancellation, bounded concurrency and capacity
recovery, expired deadline (no handler call), shared-budget consumption, request isolation, argument
immutability, content-free logging and the gateway timeout validation. The existing architecture tests
cover the new domain and application modules.

### 6. Remaining limitations

- Accounting, not preemption: a handler that blocks the event loop cannot be interrupted; the overrun is
  detected afterwards and the result discarded.
- The allowlist is a deployment policy, not authenticated RBAC or tenant authorization.
- Tool results are tagged untrusted, but semantic prompt-injection detection is not part of this phase.
- Flat schemas only; no native provider tool calling; no orchestration loop; no public API.
- Linux and remote CI NOT RUN.

### 7. Readiness for Phase B

The core is ready: provider tool-call parsing, a bounded multi-round loop (continuing one
`RequestDeadline`) and context integration of untrusted tool results can build on these contracts.
Phase B needs owner approval and a commit of Phase A first.

## Phases B and C: native tool calling and final acceptance

Status: **LOCAL PASS** (Linux and remote CI NOT RUN). Baseline: HEAD `6bfb4a4` (Phase A commit), clean tree,
`checkpoint-2.7` is an ancestor.

### Implemented

- Contracts: optional tool fields on `ChatMessage`, `CompletionRequest.tools`, `TOOL_CALL` finish rule.
- Gateway: tool capability check, rejection of tool-enabled streaming, validation that a response only
  calls offered tools with unique ids.
- Ollama: capability detection from `/api/show`, native schema mapping, strict parsing, no text fallback,
  reasoning never exposed.
- `ToolCallingOrchestrator` (max 3 rounds, 5 calls, sequential, one `RequestDeadline`, budget
  re-validation each round, duplicate-id rejection, admission released before tools run), wired as
  `app.state.tool_orchestrator`. Chat routes and ordinary completion/SSE are unchanged and never offer tools.
- Details: `docs/architecture/tool-calling.md`, `ollama-provider.md`.

### Changed files

Modified: `domain/llm.py`, `domain/errors.py`, `application/gateway.py`, `application/context.py`
(`prompts` property), `application/tools.py` (`authorized_definitions`), `infrastructure/ollama.py`,
`infrastructure/logging.py` (`tool_rounds`, `tool_calls`), `main.py`, `tests/test_gateway.py`,
`tests/test_context_management.py` (tool messages now name their call), `tests/integration/test_ollama_live.py`,
`docs/architecture/tool-calling.md`, `docs/architecture/ollama-provider.md`, this file.
New: `application/tool_orchestration.py`, `tests/test_native_tool_calling.py`.

### Live evidence (existing local `qwen3.5:35b`, loopback, no model or config change)

Capability `tool_calling=True`. Execution is proven by orchestrator metadata and `tool.execution_*` log
events, not by the answer alone.

| Case                                 | Result                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Vietnamese arithmetic (1234 x 5678)  | 1 round, `calculate` succeeded (3 args, 41 result chars), final answer 7.006.652, 3.6 s |
| English text statistics              | 1 round, `text_statistics` succeeded, final answer: 5 words, 2.3 s                      |
| Plain chat, tools on offer           | 0 rounds, 0 executions, 0.9 s                                                           |
| Ordinary SSE-path streaming          | 9 events, 7 deltas, 1 terminal                                                          |
| Deadline (`timeout_seconds=0.05`)    | `REQUEST_DEADLINE_EXCEEDED` after 0.055 s                                               |
| Recovery afterwards                  | normal answer in 1.5 s; active tool executions 0, gateway operations 0, pending tasks 0 |
| Live suite with new native-tool test | 10 passed (13.64 s), exit 0                                                             |

### Gates (actual exit codes)

| Check                                                 | Exit             | Result                                                     |
| ----------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `pytest` deterministic                                | 0                | 447 passed, 10 skipped (404 prior + 43 new)                |
| `ruff check` / `ruff format --check`                  | 0, 0             | clean                                                      |
| `mypy` strict                                         | 0                | 58 source files                                            |
| `pnpm.cmd check`                                      | 0                | web 7, NestJS 13 (unit) and e2e, Python 447 passed         |
| `prettier --check .`, `git diff --check`, secret scan | see final report | recorded after the last edit                               |
| Dependency audits                                     | NOT RUN          | manifests and lockfiles unchanged; reuses 2.7 section 28.2 |

### Limitations

No tool-enabled streaming; tool schemas consume context (no truncation, fails instead); an unknown tool
name aborts the request; handlers are cooperative; allowlist is not RBAC; semantic prompt-injection
detection deferred; Linux and remote CI NOT RUN.
