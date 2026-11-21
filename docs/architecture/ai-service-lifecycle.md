# AI service lifecycle

## Factory and startup

`create_app` returns a new FastAPI instance on every call. Settings and event logging are explicit
dependencies and tests may provide isolated instances. Production currently supplies no managed
resources because no provider or database client exists.

When Uvicorn enters lifespan, resources that are genuinely supplied are started in declaration
order. Startup is complete only after every resource starts. The lifecycle then emits a
`service.started` event.

## Failure and shutdown

- If startup fails, every successfully started resource is stopped in reverse order and the original
  startup failure is re-raised. Cleanup failures are logged without hiding that original cause.
- On normal shutdown, every started resource is stopped in reverse order.
- A failed stop does not prevent remaining cleanup. After all cleanup attempts, failures are reported
  together as a `BaseExceptionGroup`.
- `service.stopped` is emitted only after a clean shutdown.

This behavior is covered with deterministic test doubles. It does not simulate or claim provider
connectivity.

## Request lifecycle

For each HTTP request, pure ASGI middleware validates `X-Request-ID`. Values must contain 1–64 ASCII
letters, digits, `.`, `_`, or `-`. Missing or unsafe values are replaced with a random 32-character
hex identifier. The selected ID is stored in a `ContextVar`, placed on request state, returned in the
response header, and included in error bodies.

The context token is reset in `finally`, including exceptional paths. Concurrent-request tests prove
that identifiers do not leak between async tasks.
