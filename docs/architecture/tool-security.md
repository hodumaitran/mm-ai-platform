# Tool security (Phase A)

## Trust boundaries

| Input                                        | Trust     | Handling                                                              |
| -------------------------------------------- | --------- | --------------------------------------------------------------------- |
| Tool name, call id, arguments (model)        | Untrusted | Pattern-checked, bounded, snapshotted, then strictly schema-validated |
| Tool definitions and handlers                | Trusted   | Registered by application code before `seal()`; no runtime path       |
| Allowlist and limits (`ToolExecutionPolicy`) | Trusted   | Application-owned; never derived from model output                    |
| Tool result content                          | Untrusted | Bounded JSON data tagged `untrusted`; never a system instruction      |

## Guarantees

- **Deny by default.** The default policy allows nothing. A tool runs only if it is registered **and**
  named in `allowed_tools`; the allowlist must be a subset of the registered tools.
- **No dynamic code.** Handlers are ordinary callables fixed at startup. There is no import by name,
  `eval`, `exec`, shell, filesystem, network, database or interpreter tool. Demo tools are arithmetic and
  text counting only.
- **Strict arguments.** Unknown fields, missing required fields, wrong types (a boolean is not a number,
  a float is not an integer), out-of-range or non-enum values, nested values, non-finite numbers, oversized
  strings or integers, excess depth, nodes or collection length, and cyclic structures are all rejected
  before any handler runs. The payload walk is iterative, so hostile nesting cannot exhaust the stack.
- **Immutability.** Definitions, registry contents, validated arguments and the call snapshot are
  read-only; a handler that tries to mutate its arguments fails and affects no other call.
- **Bounded output.** Results are deterministic JSON limited by the policy and the same payload bounds;
  non-serializable or non-finite results are rejected.
- **Sanitized errors.** Failures carry a fixed code and message. Handler exception text, arguments and
  results never appear in errors or logs.
- **Privacy-safe logging.** Events carry only `tool_name` (logged only for a **registered** tool, never
  for an unknown name supplied by the model), `argument_count`, `result_chars`, `duration_ms`, `outcome`
  and `error_code`.
- **Resource bounds.** One request deadline, a per-tool timeout, no queue, no retries, no background
  tasks; capacity is released on success, failure, timeout and cancellation.
- **Timeout validation.** NaN, infinity, booleans, zero, negative and non-numeric values are rejected by
  the shared `validate_timeout_seconds`, which now also guards the gateway deadline (previously NaN or
  infinity could pass the gateway check).

## Known limitations

- The allowlist is a **deployment policy**. There is no authentication, RBAC, per-user or tenant
  authorization, so it must not be described as such.
- **Accounting, not preemption.** `asyncio` cannot interrupt a handler that blocks the event loop
  synchronously. The overrun is detected when it returns and the result is discarded, but the loop was
  stalled meanwhile. Handlers must be non-blocking or bounded; the demo tools are bounded by the argument
  limits. Hard isolation would need a process boundary, which is not introduced.
- Tool results are untrusted data, but **semantic prompt injection** carried in a result is not detected
  in Phase A; Phase B must label results untrusted when assembling context, and detection stays with the
  later safety checkpoint.
- Only flat schemas are supported; richer schemas are deferred until a tool needs them.
- `tool_name` is a model-visible, deployment-chosen identifier and is logged for registered tools.
- Linux and remote CI are not verified by this phase.
