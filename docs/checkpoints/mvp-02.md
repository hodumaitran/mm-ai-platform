# MVP-02: Database, authentication and persistent conversations

Status: **LOCAL PASS** (local development only, loopback services). Linux and remote CI NOT RUN.
Architecture decision: [ADR 0011](../adr/0011-postgresql-sessions-and-persistent-conversations.md).

## Architecture

Browser -> Next.js (same-origin, allow-listed proxy) -> NestJS (authentication, authorization, persistence,
SSE) -> FastAPI AI service (private) -> Ollama. PostgreSQL is reached only by NestJS.

Schema (Prisma 7 + `pg` adapter, migration `20261126084431_init`): `users`, `sessions`, `conversations`,
`messages`. UUIDv7 keys, UTC `timestamptz`, unique normalized email, `(conversationId, seq)` ordering,
`(conversationId, clientRequestId)` idempotency, one `GENERATING` message per conversation (partial unique
index), message states `GENERATING | COMPLETED | STOPPED | FAILED | INTERRUPTED`. The database image has
pgvector available; nothing uses it yet.

## What was implemented

- **Authentication:** email + password (Argon2id), opaque session token in an HttpOnly SameSite=Lax cookie
  (`__Host-` + `Secure` in production), only the token's SHA-256 stored, expiry and revocation, logout,
  `/auth/me`, CSRF token (HMAC) in `X-CSRF-Token` plus `Origin` allow-list, failed-login rate limit, one
  generic 401, deactivation revokes sessions. No self-registration.
- **Authorization:** global default-deny guard; roles ADMIN (create users, paginated list, activate/deactivate,
  cannot deactivate self) and USER. Every conversation query is scoped by the session user; there is no
  administrator endpoint for conversation content.
- **Conversations API:** create, list (paginated, title search), messages, rename, delete, send (SSE),
  regenerate (SSE). Model context is rebuilt from stored history (newest whole completed turns within the
  public limits); the client cannot send history, a system prompt, tools, a model or generation settings.
  The server-owned `mm-ai` prompt profile is still applied by the AI service.
- **Persistence behaviour:** user message stored before inference; short transactions only; answer flushed at
  most every 2 s and finalized once; stop or refresh keeps the partial answer as `STOPPED`; provider errors
  are `FAILED` with a safe code; early upstream end, restart and stale rows are `INTERRUPTED`; retry reuses the
  stored user message (same `clientRequestId`); regenerate replaces the latest answer in place; concurrent
  submissions get 409. The unauthenticated chat endpoints were removed.
- **Frontend:** Vietnamese login page, protected workspace, profile menu (role, logout, admin user
  management), persistent sidebar with title search and "load more", conversation restored after refresh
  (`#c=<id>`), session-expiry handling, all MVP-01 chat features preserved.

## Run locally

```powershell
# PostgreSQL (done once; Docker Desktop must be running). Port 5432 was taken by another project's container,
# so this project uses 55432. Credentials live in untracked apps/api/.env.
docker run -d --name mm-ai-postgres --restart unless-stopped -p 127.0.0.1:55432:5432 `
  -e POSTGRES_USER=mm_ai -e POSTGRES_PASSWORD=<local secret> -e POSTGRES_DB=mm_ai `
  -v mm-ai-pgdata:/var/lib/postgresql/data pgvector/pgvector:pg17
docker exec mm-ai-postgres psql -U mm_ai -d mm_ai -c "CREATE DATABASE mm_ai_test;"

pnpm install                              # generates the Prisma client (postinstall)
cd apps\api
pnpm db:migrate                           # prisma migrate deploy against DATABASE_URL
$env:ADMIN_EMAIL = "admin@example.com"; $env:ADMIN_PASSWORD = "<12+ chars>"
pnpm admin:bootstrap                      # creates the first ADMIN; never overwrites; no default password
cd ..\..
# then the usual three services (loopback):
#   apps\ai-service: AI_SERVICE_LLM_PROVIDER=ollama; ..\..\.venv\Scripts\python.exe -m uvicorn mm_ai_service.main:create_app --factory --host 127.0.0.1 --port 8000
#   apps\api:        node dist/main.js        (after pnpm build; reads apps/api/.env)
#   apps\web:        pnpm start               (http://127.0.0.1:3000)
```

Environment variables (see `.env.example`): `DATABASE_URL` (loopback `postgresql://`), `TEST_DATABASE_URL`
(name must end `_test`), `SESSION_SECRET` (>= 32 chars); optional `SESSION_TTL_SECONDS`,
`SESSION_COOKIE_SECURE`, `APP_ALLOWED_ORIGINS`, `LOGIN_MAX_FAILURES`, `LOGIN_WINDOW_SECONDS`,
`GENERATION_STALE_SECONDS`; bootstrap only: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_DISPLAY_NAME`.

## Evidence

**Automated, real PostgreSQL (`mm_ai_test`), fake AI service over real HTTP:** `apps/api/test/*.e2e-spec.ts`,
24 tests: login/cookie flags/no raw token or password in responses or database, identical 401 bodies for
unknown/wrong/disabled, unauthenticated access, logout revocation, expiry, CSRF + Origin, rate limit (429 +
Retry-After), role enforcement, admin create/list/paginate/deactivate (sessions die at once), readiness,
ordering, context from persisted history without client prompt, restart survival, user A vs user B and
administrator isolation (read/rename/send/regenerate/delete all 404 and no upstream call), pagination and
title search, retry without duplicate turn and replay 409, provider error -> FAILED, regenerate in place,
concurrent submissions (409 and consistent state), disconnect -> STOPPED with partial text, stale and restart
recovery, database invariants (second GENERATING, duplicate seq, non-normalized email rejected by PostgreSQL).
Unit tests: context selection, SSE frame parser, cookies, rate limiter, environment validation.

**Live (real `qwen3.5:35b`, Playwright, loopback, `next start`):**

- Cold first request through login -> API -> AI service: 126.6 s total, 122.3 s to first token (model load).
- Vietnamese and English answers, multi-turn from the database ("Tên tôi là gì?" -> "Tên bạn là An."; an
  English question answered, then restated in Vietnamese), 0.9-1.4 s per warm turn.
- Stop after 2.5 s: UI "Đã dừng", row `STOPPED` with 354 characters, next request succeeded (`COMPLETED`).
- Browser reload during generation: row `STOPPED` with 401 characters, conversation restored after reload,
  cancellation logged by the AI service (`chat.stream_cancelled`).
- Regenerate: row replaced in place (16 messages before and after, 0 `GENERATING`).
- Logout -> login again -> history restored; API restarted while logged in -> still signed in, history intact.
- Session expired in the database -> next send returned to the login page with the expiry notice.
- Two users: Bình could not read, rename, send to, regenerate or delete An's conversation (all 404), opening
  An's URL showed "Không mở được cuộc trò chuyện này", USER got 403 on `/users`, a POST without CSRF got 403,
  the removed `/api/v1/chat/completions` route is 404; the browser has no readable cookie, `localStorage` or
  `sessionStorage` entries (`document.cookie` empty).
- Admin created two employees from the user-management dialog; `bootstrap` refuses an existing email, a short
  password and a missing password.
- API, web and AI service logs contain no passwords, session cookies or conversation text (grep: 0 matches).
- Screenshots: `.playwright-mcp/mvp02-login.png`, `mvp02-admin-chat.png`, `mvp02-admin-panel.png`,
  `mvp02-mobile.png`.

## Gates

See the final report for exit codes. Python tests: 449 passed, 10 skipped. Web unit tests: 24. API unit: 26;
API e2e: 24 (real PostgreSQL). `pnpm audit` was clean only after pinning the dev-tool dependency `effect` to
3.22.5 (a high ReDoS advisory in the version Prisma 7.10.1 pins); `pip-audit` clean.

## Limitations and notes

- Single API instance: in-memory login limiter; restart marks running generations `INTERRUPTED`.
- A refresh or navigation during generation stops it (partial answer kept); there is no re-attach to a running
  generation and a second tab cannot observe it.
- No password change/reset, no email, no audit log, no per-user quotas; administrators cannot read private
  conversations by design (and cannot recover passwords).
- Local HTTP only: the `Secure` cookie path is configured but was not exercised over HTTPS.
- CI: PostgreSQL tests are wired for the Linux job only (service container); the Windows job runs
  `check:js:nodb`. The workflow change was not executed (CI NOT RUN).
- Port 5432 was occupied by an unrelated container (`vls-postgres`), left untouched; this project uses 55432.
- Docker Desktop was started for this checkpoint (it was installed but stopped); it holds RAM next to the model.
- The IME/keyboard behaviours were tested with synthetic events only.
