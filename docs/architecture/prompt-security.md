# Prompt security boundaries

## Structural controls (implemented)

- Definitions and profiles are server-owned startup assets; the registry is sealed before use and
  there is no public administration or profile-selection endpoint.
- System and assistant templates may reference only **trusted** variables; untrusted variables are
  allowed only in `user` templates. The check runs when a definition is created.
- A caller cannot supply a trusted variable (`PROMPT_POLICY_VIOLATION`) or an undeclared one
  (`UNKNOWN_PROMPT_VARIABLE`). `PromptInvocation` has no model, role or trusted-value field.
- Caller content is appended as exactly one `user` message and cannot create roles or replace the
  trusted system instructions.
- The model comes from trusted configuration, not from the caller.
- Execution integrity: `complete`/`stream` rebuild every request from a `PromptInvocation`; a
  caller-constructed `PromptExecution` is rejected and never reaches the gateway. Gateway capability,
  admission and deadline checks remain authoritative.
- Rendering is single-pass over the original template; values are data and are never re-scanned.
  There is no evaluation, I/O, import, traversal or function invocation.
- Runtime limits cannot be exceeded by profiles or caller options; over-limit and over-budget
  requests are rejected, never truncated.
- Logs and errors contain only identifiers, error codes and numeric measurements.

## Not provided

These controls prevent structural role escalation and template execution. They do **not** prevent
semantic prompt injection through ordinary user text, nor do they police model output; broader
guardrails are deferred to Checkpoint 2.9. Token budgets are estimates (see
`prompt-management.md`). Authentication and RBAC are not implemented; service listeners remain
loopback-only, and profile selection is an internal capability, not a privilege boundary exposed to
callers.
