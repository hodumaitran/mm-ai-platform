# MVP-01 / MVP-01.1: Functional AI chat application

Status: **LOCAL PASS** (MVP-01.1 finalization appended below) (local development only; no authentication). Linux and remote CI NOT RUN.

## What it is

A Vietnamese, light-theme chat UI at `http://127.0.0.1:3000` using the existing path
Browser → Next.js route handler → NestJS → FastAPI → LLM Gateway → Ollama (`qwen3.5:35b`). The browser only
talks to same-origin `POST /api/v1/chat/completions/stream`; no backend, provider or model address reaches it.

Features: collapsible sidebar (drawer on mobile), new conversation, conversation list with delete, user and
assistant messages, multiline composer (Enter sends, Shift+Enter newline, 2,048-character counter), Send and
Stop, real SSE streaming, multi-turn context, copy answer, copy code, retry after an error, safe Markdown,
and error states for model unavailable, context exceeded, timeout, capacity, network and interrupted streams.

## Run locally (all services bind to loopback)

```powershell
# 1. Ollama must already be running with qwen3.5:35b (not started or modified by this project)
# 2. FastAPI AI service
$env:AI_SERVICE_LLM_PROVIDER = "ollama"
.venv\Scripts\python.exe -m uvicorn mm_ai_service.main:create_app --factory --host 127.0.0.1 --port 8000   # run in apps\ai-service
# 3. NestJS API and Next.js (build once, then start)
pnpm.cmd build
cd apps\api; node dist/main.js          # 127.0.0.1:3001
cd apps\web; pnpm.cmd start             # 127.0.0.1:3000
```

`pnpm.cmd dev` starts the two JavaScript services in development mode. The first request after Ollama has
unloaded the model can take about three minutes (cold load); the UI shows "Đang tạo câu trả lời…" meanwhile.

## Design decisions

- **Conversation state is in browser memory only.** Refreshing or closing the page loses all conversations
  (stated in the sidebar). There is no database or persistence in this checkpoint.
- **Context within existing limits.** The server accepts at most 16 messages, 2,048 characters per message and
  3,072 characters in total. The client sends the newest whole turns that fit; older turns are dropped (never
  truncated) and the user is told. A previous answer longer than 2,048 characters cannot be sent as history, so
  the output cap is 512 tokens. Failed turns are not sent.
- **Safe rendering.** Markdown is parsed into a data tree and rendered as React elements; raw HTML stays literal
  text, only `http(s)` links are produced (`rel="noopener noreferrer nofollow"`), no images. No
  `dangerouslySetInnerHTML`.
- **No client authority.** The request carries only messages, generation numbers and `thinking: disabled`. No
  system prompt, tool, model or provider field can be sent, and the reasoning is never exposed by the backend.
- **Proxy change.** The Next.js proxy now keeps the safe upstream failure category (422, 429, 503, 504) for
  stream requests instead of collapsing everything to 502; upstream bodies are still never forwarded.
- Stopping aborts the browser `fetch`; the abort propagates through Next.js and NestJS to FastAPI and the
  gateway, which logs `chat.stream_cancelled`.

## Evidence (existing local model, no mock or simulated streaming)

- Cold start through the full chain: HTTP 200, 175 s to first byte, then real `content.delta` events and a
  terminal `stream.completed` (prompt 27, completion 16 tokens).
- Browser, Vietnamese: a request for a Python function returned streamed Markdown with a copyable code block;
  a literal `<script>` in the prompt appeared as text (0 script elements, no execution).
- Multi-turn: asked "Tên tôi là gì?" after stating a name two turns earlier; the model answered "Minh."
- English: long essay request streamed; **Stop** after about 3 s kept the partial text with "Đã dừng tạo câu
  trả lời", and FastAPI logged `llm.request_cancelled` and `chat.stream_cancelled` at the same second. The next
  request ("Say OK in one word.") answered normally (capacity recovered).
- Empty message: Send disabled, no turn created. 2,049 characters: Send disabled, warning and counter shown.
- New conversation: returns to the empty workspace; the earlier conversation stays in the list.
- Error states, real: with the AI service stopped the UI showed the generic error with **Thử lại**; after
  restarting the service, **Thử lại** produced an answer. Error states, by intercepting `fetch` in the real
  page: 503 → model unavailable, 422 → context exceeded, 504 → timeout, 429 → capacity messages.
- Responsive: 1280 px (sidebar + workspace) and 390 px (drawer, composer) screenshots in `.playwright-mcp/`.

## Gates

See the final report for exit codes. Web unit tests: 23 pass (14 new: SSE parsing, history limits, Markdown
safety, streaming and error mapping, abort, proxy status passthrough).

## Limitations

- No authentication or authorization: do not expose beyond loopback.
- No persistence; one generation at a time; switching conversations stops the running generation.
- Distinguishing "model unavailable" from "service overloaded" depends on the backend status (both can be 503).
- Tool calling exists in the backend (2.8) but is deliberately not reachable from the chat UI.
- Markdown subset only: no tables or images; cold model load can take about three minutes.
- Hard timeouts come from the backend (first token 240 s, total 300 s); the UI adds none of its own.

## MVP-01.1: finalization and runtime hardening

### HTTP 499 on the first request (user report: 206 ms, `REQUEST_CANCELLED`)

**Status: not reproduced; root cause unresolved.** A 499 is the service's deliberate answer when the client
disconnects before the first stream event (`RequestCancelledError`); it means something closed the
connection, not that the service failed. The original evidence is retained as reported (first request
`llm.stream_started` -> `llm.request_cancelled` -> 499 at 206 ms, next request fine).

Attempts on the same stack in `next dev` mode, real `qwen3.5:35b`, Playwright:

1. Cold model, first request after a fresh start: 200, 179 s total, 177 s to first token, 77 tokens, no cancellation.
2. Warm model, `.next/dev` deleted so the route is compiled on the first request: 200 in 620 ms.
3. Two rapid duplicate submissions (see defect 1): both ran to completion, no cancellation.
4. Whole acceptance session below: the only cancellation logged was the intentional **Stop**.

Reviewed and found not to abort on their own: React Strict Mode (requests start in event handlers, not
effects), `AbortController` ownership (aborted only by Stop, new conversation, selecting another
conversation and deleting the active one), the Next.js proxy (`request.signal` and its own deadline),
NestJS (`response.close`/`request.aborted` only) and the FastAPI pre-header disconnect check. Timeouts were
not increased. Intentional cancellation logs `chat.stream_cancelled` (after headers) or 499 (before the
first event); an unexpected one would appear without any Stop/switch/reload at that moment. If it recurs,
capture the browser Network tab and the Next.js/NestJS logs for that request id.

### Confirmed defects fixed

1. **Duplicate submission.** Two Enter presses in the same tick both passed the `generating` check (state
   is stale until re-render), creating two conversations and two inference requests. Fixed with a
   synchronous ref guard (`busy`); Stop still cancels the only request.
2. **Retry/regenerate rewrote history unsafely.** Retry was offered on any failed turn; it is now only on
   the latest turn and replaces it (no duplicate message).
3. **Context warnings were inaccurate.** A global notice was computed client-side and cleared on
   navigation. Each answer now records how many earlier turns were left out (client limits plus the
   server's `context.prepared` count).
4. **IME.** Enter that confirms a composition (`isComposing`, composition events, `keyCode 229`) no longer
   sends.

### Added

- Rename conversation (inline, Enter/Esc), delete with inline confirmation, regenerate latest answer,
  retry without duplication, cold-start hint after 8 s without output.
- **MM AI identity** (server-owned, sealed `mm-ai` prompt profile, ADR 0010): name MM AI, internal assistant
  of MM Research, replies in the user's language, no invented facts, states uncertainty, claims no Internet
  or internal-document access. Public chat now runs through `ContextService`; new additive SSE event
  `context.prepared` (counts only). The client still cannot send or read a system prompt.

### Runtime evidence (real model, `next dev`, loopback)

- Cold start: 177 s to first token, 179 s total (measured before the identity prompt was added).
- Identity question in Vietnamese: "Tôi là MM AI, trợ lý AI nội bộ của MM Research. Tôi không có quyền truy
  cập vào các tài liệu nội bộ..." (0.7 s to first token, 2.4 s total, warm).
- Five sequential warm requests in one conversation (Vietnamese and English, multi-turn: "Tên tôi là gì?"
  -> "Tên của bạn là Minh."): first output 0.33-0.76 s, total 0.42-0.98 s.
- Stop after 2.5 s of a long essay: partial text kept, `llm.request_cancelled` and `chat.stream_cancelled`
  logged; the next request answered immediately ("OK").
- Duplicate submission now yields exactly one conversation and one turn; IME and `keyCode 229` Enter do
  not send (synthetic keyboard events, not a physical IME).
- Regenerate keeps one turn; retry after a 503 keeps one turn (the 503 was injected by intercepting `fetch`
  in the real page; the retry hit the real model).
- Context limits: four ~1,300-character messages; later answers report 1 and then 2 earlier turns omitted;
  server logs show 1 history turn included, 0 excluded. The server estimate (about 1,900 prompt tokens) is
  conservative against the provider count (758).
- Rename, cancel delete, confirm delete, conversation isolation, safe Markdown (0 `script`/`img`, literal
  `<script>` text, 2 copyable code blocks) and mobile drawer (390 px) verified in the browser.
- Screenshots: `.playwright-mcp/final-desktop.png`, `final-mobile.png`, `final-mobile-drawer.png`.

### Remaining limitations

No authentication or persistence (refresh resets); one generation at a time; switching conversation
stops the running generation; real "model down" and real timeout states were not driven in the browser in
this round (earlier real service-down test and intercepted 503/504 cover them); Linux/remote CI NOT RUN.
