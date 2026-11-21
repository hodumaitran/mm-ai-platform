# LLM provider and domain contracts

## Immutable domain types

- `ChatMessage`: validated system, user, assistant, or tool role and non-empty content.
- `CompletionRequest`: validated model identifier, non-empty immutable messages, generation options,
  and thinking mode.
- `GenerationOptions`: optional temperature, output limit, context window, and immutable stop
  sequences. Invalid ranges and output/context conflicts are rejected.
- `CompletionResponse`: matching model identifier, assistant message, finish reason, token usage, and
  at most 32 uniquely keyed provider-neutral scalar metadata entries. Keys and string values are
  bounded, and non-finite numbers or mutable/nested values are rejected.
- `TokenUsage`: non-negative prompt/completion/total values. Every field may be `None` when the
  provider supplies no usage; the gateway never fabricates values.
- `ModelCapabilities`: chat, streaming, thinking, tool-calling, structured-output flags, and an
  optional positive context constraint.

Model identifiers use a provider-neutral validated syntax and may contain letters, digits, `.`, `_`,
`:`, `/`, and `-`. Domain/application code contains no Ollama, Qwen, vLLM, HTTP-client, or SDK import.
Requests containing a `tool` message require the declared tool-calling capability.

## Provider protocol

An infrastructure adapter implements `LLMProvider`:

- stable lowercase `provider_id`;
- immutable `capabilities`;
- asynchronous `complete(request)`;
- `stream(request)` returning an async iterator of typed events.

Adapters must translate transport failures into the stable gateway taxonomy, validate raw provider
payloads before constructing domain results, propagate cancellation, and avoid logging confidential
input/output. Provider URLs, credentials, raw responses, and exception messages must not cross the
adapter boundary.

## Error taxonomy and future HTTP mapping

| Category                     | Code                          |        Future HTTP status |
| ---------------------------- | ----------------------------- | ------------------------: |
| Invalid completion request   | `INVALID_COMPLETION_REQUEST`  |                       400 |
| Provider unavailable/unknown | `PROVIDER_UNAVAILABLE`        |                       503 |
| Provider connection failure  | `PROVIDER_CONNECTION_FAILURE` |                       503 |
| Provider timeout             | `PROVIDER_TIMEOUT`            |                       504 |
| Provider overload            | `PROVIDER_OVERLOAD`           |                       503 |
| Unsupported capability       | `UNSUPPORTED_CAPABILITY`      |                       422 |
| Invalid provider response    | `INVALID_PROVIDER_RESPONSE`   |                       502 |
| Request cancelled            | `REQUEST_CANCELLED`           | 499 (internal convention) |
| Internal gateway failure     | `INTERNAL_GATEWAY_FAILURE`    |                       500 |

These mappings extend the existing safe `ServiceError` contract but no chat HTTP endpoint exposes
them yet. Caller cancellation propagates as `asyncio.CancelledError`; `REQUEST_CANCELLED` is available
for a future adapter-normalized remote cancellation, not for swallowing local task cancellation.

## Registration and ownership

`ProviderRegistry` receives an explicit immutable provider sequence and one configured identifier.
Duplicate/invalid identifiers are configuration errors. Missing and unknown selections are distinct
typed failures with the same safe public category. Registry construction performs no discovery,
network call, model load, or fallback.
