# ADR 0010: Public chat goes through the context service with a server-owned MM AI identity

## Status

Accepted for MVP-01.1.

## Context

The public chat endpoints passed client messages straight to the gateway, so the assistant had no
identity and no statement of its limits (no Internet, no internal documents), and history that did not
fit the model context could only be rejected. The prompt registry and `ContextService` already exist
(ADR 0007, ADR 0008) but were not on the public path.

## Decision

`/v1/chat/completions` and `/v1/chat/completions/stream` map the validated public request to a
`ContextInvocation` for the sealed `mm-ai` prompt profile: the last message is the current turn and
earlier messages are conversation history. `ContextService.prepare` adds the server-owned system prompt,
budgets it with the existing estimator and drops whole old turns when needed; execution still goes through
the `LLMGateway` with the same deadline, admission and cancellation behaviour. The system prompt is
never accepted from or returned to clients: the public schema still rejects `system` and tool fields.

The stream gains one additive event, `context.prepared`, carrying only the counts of history turns
included and excluded, so the UI can warn accurately when the server dropped turns. Existing events and
the public request schema are unchanged.

## Consequences

- Public limits (16 messages, 2,048 characters per message, 3,072 in total, 1,024 output tokens) stay.
- The system prompt consumes context budget (about 130 real prompt tokens); the heuristic estimator is
  deliberately conservative, so the server may drop history earlier than the model strictly requires.
- No storage and no new dependency; the prompt is a built-in asset changed only by a code change.
