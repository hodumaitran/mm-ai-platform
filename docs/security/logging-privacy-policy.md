# AI service logging privacy policy

AI-service operational logs are newline-delimited JSON written to local process output. No external
exporter, telemetry backend, or network sink is configured.

Every event contains timestamp, severity, service, event name, and a nullable request ID. Additional
metadata is allowlisted to: method, URL path without query string, HTTP status, duration, safe machine
error code, exception class name, and managed-resource class name.

The logger drops unknown metadata keys. The HTTP middleware never reads or logs request bodies,
queries, cookies, authorization headers, arbitrary headers, prompts, documents, tokens, credentials,
personal information, or exception messages. Tests send sentinel secrets in a query, header, and JSON
body and assert none appears in captured logs.

Request IDs are untrusted metadata. Only 1–64 ASCII alphanumeric characters plus `.`, `_`, and `-`
are accepted; all other values are replaced rather than logged.

Future code must extend the allowlist only after privacy review and must add a negative disclosure
test for every new metadata field.

LLM Gateway events contain only fixed event names and safe machine error codes. Model identifiers,
provider configuration, prompts, completions, token content, and reasoning traces are not logged.
The Ollama adapter emits no request/response logs, ignores `message.thinking` payloads, disables
environment-derived HTTP proxies, and never serializes raw provider errors.

Checkpoint 2.7 extends the allowlist, after privacy review and with disclosure tests, by these bounded
content-free keys: `context_items`, `context_limit`, `history_turns_included`,
`history_turns_excluded`, `reference_items_included`, `reference_items_excluded`, `prompt_identifier`,
`prompt_version`. Prompt identifiers and versions are server-owned values. Conversation identifiers,
history, reference text, user content, and variable values are never logged and have no allowlisted key.
