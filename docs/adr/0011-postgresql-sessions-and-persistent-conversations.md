# ADR 0011: PostgreSQL, cookie sessions and persistent conversations in NestJS

## Status

Accepted for MVP-02.

## Context

MVP-01 kept conversations in browser memory and had no identity. The internal release needs several
users, private persistent history and an authentication boundary, without exposing the AI service.

## Decision

- **Database:** self-hosted PostgreSQL (local, loopback only) with Prisma 7 and the `pg` driver adapter.
  Tables `users`, `sessions`, `conversations`, `messages`; UUIDv7 keys, `timestamptz` UTC columns,
  version-controlled migrations (`apps/api/prisma/migrations`). The development image is
  `pgvector/pgvector`, but no extension is enabled and no vector code exists yet.
- **Invariants in the database, not only in code:** unique normalized email (CHECK), `(conversationId, seq)`
  unique for deterministic order, `(conversationId, clientRequestId)` unique for idempotent retries, and a
  partial unique index allowing at most one `GENERATING` message per conversation.
- **Authentication:** NestJS is the only authority. Argon2id (`@node-rs/argon2`) password hashes; opaque
  256-bit session tokens delivered in an HttpOnly, SameSite=Lax cookie (`__Host-` prefix and `Secure` in
  production); only the SHA-256 of the token is stored. CSRF token = HMAC(server secret, token hash),
  required in `X-CSRF-Token` for every state-changing request, plus an `Origin` allow-list. Failed-login
  limiter per account and per client address. One generic 401 for every login failure. No self-registration;
  administrators create accounts; the first administrator comes from an explicit bootstrap command.
- **Authorization:** a global guard (default deny; only login and health are `@Public`) with roles
  `ADMIN`/`USER`. Every conversation query includes the session user's id, so another user's id is a
  not-found. Administrators can manage accounts but have no endpoint to read conversation content.
- **Persistent generation:** a short transaction locks the owned conversation, rejects concurrent
  generation, stores the user message and a `GENERATING` assistant row, and builds the model context from
  stored history (newest whole completed turns within the public limits). Inference runs outside any
  transaction. The accumulated answer is flushed at most every two seconds and finalized as
  `COMPLETED`, `STOPPED` (client left or pressed Stop), `FAILED` (with a safe error code) or `INTERRUPTED`
  (upstream ended early, process restart, stale). The old unauthenticated chat endpoints were removed.
- **Browser path:** the Next.js server proxies an allow-list of API routes (cookies and CSRF header forwarded,
  `Set-Cookie` relayed). The browser never learns internal addresses; FastAPI and Ollama stay private.

## Consequences

- Single API instance assumed: restart marks in-flight generations `INTERRUPTED`; the login limiter is
  in memory. Scaling out needs a shared limiter and an instance-aware recovery.
- A browser refresh during a generation stops it (the partial answer is kept as `STOPPED`).
- Test suites need a real PostgreSQL whose name ends in `_test`; CI runs them on Linux only.
- Administrators cannot recover a user's password or read their conversations; a forgotten password needs a
  new account or a future reset flow (out of scope).
