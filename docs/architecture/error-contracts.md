# AI service error contracts

All HTTP failures use a stable body and return the selected request ID in both the body and
`X-Request-ID` response header:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "The request is invalid.",
    "request_id": "f92c3ccf1ee8d21f70f0f67f5ef41889"
  }
}
```

| Category                 | Machine code             | HTTP status | Disclosure policy                        |
| ------------------------ | ------------------------ | ----------: | ---------------------------------------- |
| Invalid domain request   | `INVALID_REQUEST`        |         400 | Safe domain message only                 |
| FastAPI input validation | `INVALID_REQUEST`        |         422 | Generic message; no validation internals |
| Configuration failure    | `CONFIGURATION_ERROR`    |         500 | Generic misconfiguration message         |
| Capability unavailable   | `CAPABILITY_UNAVAILABLE` |         503 | Generic availability message             |
| Unexpected failure       | `INTERNAL_ERROR`         |         500 | Generic message; exception text omitted  |

Settings validation normally fails before the HTTP server starts. `CONFIGURATION_ERROR` exists for a
future runtime configuration boundary and is tested as a presentation mapping; it is not used to
hide startup validation failures.

## Future provider mapping

Provider integration is not implemented. When it is introduced, adapters must translate provider
exceptions at their boundary. A provider timeout, connection refusal, overload, or unavailable model
should normally become `CAPABILITY_UNAVAILABLE`; malformed provider output should become an internal
error. Provider response bodies, URLs containing credentials, model prompts, and exception messages
must never be serialized to callers. New mappings require explicit contract tests.
