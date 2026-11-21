# Model-neutral LLM Gateway

## Implemented boundary

Checkpoint 2.3 implements an in-process application service, not an HTTP chat endpoint and not a
provider adapter. All tests use deterministic fake providers. The production composition root has no
configured provider by default and makes no outbound inference request.

```mermaid
flowchart LR
  P[Future presentation endpoint] --> G[LLMGateway]
  G --> R[Explicit ProviderRegistry]
  G --> C[Domain contracts and capabilities]
  G --> S[Concurrency semaphore]
  G --> T[End-to-end deadline]
  R --> I[LLMProvider protocol]
  OA[Future Ollama adapter] -. Checkpoint 2.4 .-> I
  VA[Future vLLM adapter] -. not implemented .-> I
```

## Request flow

1. Resolve exactly the configured provider identifier. There is no automatic discovery or fallback.
2. Validate chat, thinking, streaming, and context capabilities before entering provider capacity.
3. Merge caller options with explicit defaults: temperature `0.2`, maximum output tokens `1024`, and
   context window `4096` unless configured otherwise.
4. Apply one end-to-end deadline around queue waiting and provider execution/iteration.
5. Acquire bounded capacity. The default and local-inference target is one concurrent request.
6. Call the asynchronous provider contract and validate its provider-neutral response or stream.

No retry occurs. Unknown or absent providers report unavailability and never fall back to an external
service.

## Timeout, concurrency, and cancellation

`AI_SERVICE_LLM_MAX_CONCURRENCY` controls an `asyncio.Semaphore` and defaults to `1`.
`AI_SERVICE_LLM_REQUEST_TIMEOUT_SECONDS` defaults to `120`. The timeout includes time waiting for the
semaphore and the complete provider operation; streaming uses the same deadline across the full async
iteration. A queued request therefore cannot wait indefinitely.

Context managers release capacity after success, normalized failure, timeout, or cancellation.
External `asyncio.CancelledError` is logged only as a safe event and re-raised unchanged. It is not
converted into an internal failure. Providers must propagate cancellation and clean up their own
transport. Gateway code never silently retries.

## Thinking

`ThinkingConfiguration` has `default`, `enabled`, and `disabled` modes. Enabled mode requires the
provider's thinking capability. Default and disabled modes do not assume thinking support. The
contract contains no Qwen parameter and carries no reasoning trace. Provider-specific translation is
deferred to a future adapter.

## Streaming

The gateway exposes an internal async iterator with typed events: `StreamStarted`, `ContentDelta`,
`UsageUpdate`, `CompletionFinished`, and `StreamError`. A stream must start with `StreamStarted`, end
with a terminal finished/error event, match the requested model identifier, and contain only known
event types. Events are yielded as received without buffering or splitting a completed response.

Consumers must iterate or close/cancel the async generator. Cancellation closes the provider iterator
and releases capacity. There is no SSE or other public transport in this checkpoint.

## Runtime readiness

`/health` remains process liveness. `/ready` reports inference false when no configured provider is
registered, which is the production state in Checkpoint 2.3. It does not contact Ollama.
