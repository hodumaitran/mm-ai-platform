# Context security boundaries

## Trust model

Trust is a property of the source and is fixed in `SOURCE_TRUST`:

| Source                 | Trust     | Notes                                                               |
| ---------------------- | --------- | ------------------------------------------------------------------- |
| `trusted_prompt`       | trusted   | Server-rendered templates with trusted variables only               |
| `current_request`      | untrusted | The caller's request (and prompt messages with untrusted variables) |
| `conversation_history` | untrusted | Caller-supplied; the assistant role does not make it trusted        |
| `reference_material`   | untrusted | Framed as data, delivered in the `user` role                        |

No public contract accepts a trust level or role. Only a `trusted_prompt` item can use the `system`
role; `ContextItem` and the final assembly check both enforce it. Caller text cannot create roles
because roles come from position (history is strictly user then assistant) and from the server.

## Isolation: what is and is not guaranteed

Guaranteed structurally: snapshots are immutable and owned by one conversation (a foreign turn is
rejected); `ContextService` stores nothing, so there is no shared mutable history, no cross-request
state, and no process-global registry; each application instance builds its own services.

**Not** guaranteed: authenticated ownership. Authentication and tenant RBAC do not exist, and history
is caller-supplied, so a caller can fabricate assistant turns. Structural isolation must not be read
as production tenant isolation. Reference and history text are delimited data, but a delimiter does
not stop a model from following instructions inside it; semantic prompt injection is a residual risk
deferred to Checkpoint 2.9.

## Integrity

`complete` and `stream` accept only a `ContextInvocation` and rebuild every item, budget, and request
themselves. A caller-built `ContextAssemblyResult`, `CompletionRequest`, `PromptInvocation`,
`PromptExecution`, or any other object is rejected with `CONTEXT_POLICY_VIOLATION` before the gateway.
The model is the trusted constructor argument of `PromptService`. Reference identifiers that collide
with reserved item identifiers are rejected.

## Privacy

Logs carry only fixed event names and bounded metadata: `prompt_identifier`, `prompt_version`,
`context_items`, `context_limit`, `history_turns_included/excluded`,
`reference_items_included/excluded`, `prompt_tokens`, `duration_ms`, `outcome`, `error_code`, plus the
request correlation ID. Conversation identifiers, history, references, user content, variable values,
completions and reasoning are never logged, and public error messages contain no input. Each new key
was added to the logging allowlist with a disclosure test; see `docs/security/logging-privacy-policy.md`.
