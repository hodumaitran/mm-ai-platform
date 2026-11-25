# Ollama provider adapter

## Boundary and ownership

`infrastructure/ollama.py` implements the application `LLMProvider` protocol. Ollama paths, JSON
schemas, status codes, and thinking fields never cross into domain/application contracts. The
composition root creates the adapter only when `AI_SERVICE_LLM_PROVIDER=ollama`, registers it, and
adds the same instance to application lifespan resources.

`start()` creates one pooled `httpx.AsyncClient`; it is not recreated per inference request. `stop()`
closes that client. Client creation performs no model download or inference. The client has explicit
connect/read/write/pool timeouts, at most two connections and one keep-alive connection, redirect
following disabled, and `trust_env=False` so proxy environment variables cannot redirect prompts.
The gateway's timeout remains the overall deadline and includes queue waiting.

## Configuration

| Variable                                      | Default                  | Policy                                                            |
| --------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `AI_SERVICE_LLM_PROVIDER`                     | unset                    | Set to `ollama` to compose the adapter                            |
| `AI_SERVICE_OLLAMA_BASE_URL`                  | `http://127.0.0.1:11434` | HTTP origin, explicit port, no credentials/path/query             |
| `AI_SERVICE_OLLAMA_MODEL`                     | `qwen3.5:35b`            | One validated model identifier; arbitrary request models rejected |
| `AI_SERVICE_OLLAMA_NETWORK_POLICY`            | `loopback`               | `private` requires production and an explicit private IP          |
| `AI_SERVICE_OLLAMA_CONNECT_TIMEOUT_SECONDS`   | `5`                      | Connect/write/pool bound                                          |
| `AI_SERVICE_OLLAMA_READ_TIMEOUT_SECONDS`      | `120`                    | Per-read bound; gateway still owns overall deadline               |
| `AI_SERVICE_OLLAMA_READINESS_TIMEOUT_SECONDS` | `3`                      | Whole metadata probe bound                                        |
| `AI_SERVICE_OLLAMA_READINESS_CACHE_SECONDS`   | `10`                     | Avoids provider calls on every readiness request                  |

Only loopback is accepted by default. Private-network production support is opt-in and restricted to
literal private IP addresses, preventing arbitrary public hosts and hostname/DNS rebinding. HTTPS
and authentication are not introduced because this checkpoint targets a trusted local/private Ollama
origin; private-network deployment must add transport security at the approved infrastructure layer.

## API mapping

The adapter uses the official local endpoints:

- `GET /api/version`: service connectivity and response-contract check.
- `GET /api/tags`: exact configured-model inventory check.
- `POST /api/show`: completion/thinking capability discovery; no model load or generation.
- `POST /api/chat`: non-streaming JSON or streaming NDJSON completion.

Messages map to `{role, content}`. Generation options map to `temperature`, `num_predict`, `num_ctx`,
and `stop`. Thinking `enabled`/`disabled` map to `think: true/false`; default omits the field. The
adapter discards Ollama's `message.thinking` completely and exposes only final answer content.

`prompt_eval_count` and `eval_count` map to prompt/completion usage. Total usage is derived only when
both provider counts exist; missing values remain unknown. `stop`, `length`, and `cancelled` finish
reasons map directly; unknown provider reasons map to `other`.

Streaming yields a typed start event, answer content deltas, and one terminal finished/error event.
It never converts a completed response into fake chunks. Cancellation exits the HTTP response context,
closes the response stream, and propagates `CancelledError`.

## Errors and capabilities

- HTTP 404/model mismatch: `MODEL_UNAVAILABLE`.
- Connect failure/timeout: `PROVIDER_CONNECTION_FAILURE`.
- Read/inference timeout or HTTP 408/504: `PROVIDER_TIMEOUT`.
- HTTP 429: `PROVIDER_OVERLOAD`.
- Other 5xx: `PROVIDER_UNAVAILABLE`.
- Invalid status/payload/NDJSON: `INVALID_PROVIDER_RESPONSE`.

The adapter declares chat/streaming only for a model advertising `completion`. Thinking derives from
`/api/show`. Tool calling and structured output remain false because this adapter does not map those
contracts. The enforced context limit is the smaller of configured policy and discovered model
metadata.

Official references: [chat API](https://docs.ollama.com/api/chat),
[model inventory](https://docs.ollama.com/api/tags),
[model details](https://docs.ollama.com/api-reference/show-model-details.md), and
[thinking controls](https://docs.ollama.com/capabilities/thinking).
