import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { forwardChatRequest } from '../src/server/chat-proxy.ts';
import {
  ChatError,
  failureFromCode,
  failureFromStatus,
  streamChat,
} from '../src/lib/chat-client.ts';
import {
  MAX_MESSAGE_CHARACTERS,
  buildRequestMessages,
  conversationTitle,
  normalizeTitle,
  validateDraft,
} from '../src/lib/conversation.ts';
import { parseInline, parseMarkdown } from '../src/lib/markdown.ts';
import { createSseParser } from '../src/lib/sse.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.API_BASE_URL;
});

const turn = (id, user, assistant, status = 'done') => ({ id, user, assistant, status });

// --- SSE parser ---------------------------------------------------------------------------------

test('SSE parser reassembles frames split at arbitrary byte boundaries', () => {
  const events = [];
  const feed = createSseParser((event) => events.push(event));
  const text =
    'event: stream.started\ndata: {"a":1}\n\nevent: content.delta\r\ndata: {"content":"Xin chào"}\r\n\r\n: keepalive\n\n';
  for (const piece of text.match(/.{1,3}/gs)) feed(piece);
  assert.deepEqual(events, [
    { event: 'stream.started', data: { a: 1 } },
    { event: 'content.delta', data: { content: 'Xin chào' } },
  ]);
});

test('SSE parser skips malformed JSON and incomplete trailing frames', () => {
  const events = [];
  const feed = createSseParser((event) => events.push(event));
  feed('event: x\ndata: {bad\n\nevent: y\ndata: {"ok":true}\n\nevent: z\ndata: {"partial"');
  assert.deepEqual(events, [{ event: 'y', data: { ok: true } }]);
});

// --- conversation limits ------------------------------------------------------------------------

test('draft validation rejects empty and oversized messages', () => {
  assert.equal(validateDraft('   \n'), 'empty');
  assert.equal(validateDraft('x'.repeat(MAX_MESSAGE_CHARACTERS)), 'ok');
  assert.equal(validateDraft('x'.repeat(MAX_MESSAGE_CHARACTERS + 1)), 'too-long');
});

test('request messages keep alternation, newest whole turns and public limits', () => {
  const previous = [turn('1', 'a', 'b'), turn('2', 'c', 'd'), turn('3', 'e', 'f', 'error')];
  const { messages, omitted } = buildRequestMessages(previous, 'next');
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user'],
  );
  assert.equal(omitted, 0);
  assert.equal(messages.at(-1).content, 'next');
});

test('old turns are dropped, never truncated, when the aggregate limit is reached', () => {
  const big = 'x'.repeat(1000);
  const previous = [turn('1', big, big), turn('2', big, big)];
  const { messages, omitted } = buildRequestMessages(previous, 'hello');
  assert.equal(omitted, 1);
  assert.equal(messages.length, 3);
  const total = messages.reduce((sum, m) => sum + m.content.length, 0);
  assert.ok(total <= 3072);
  assert.ok(messages.every((m) => m.content.length <= MAX_MESSAGE_CHARACTERS));
});

test('an over-long assistant reply is not sent as history and stops older turns too', () => {
  const previous = [turn('1', 'a', 'b'), turn('2', 'c', 'y'.repeat(2049))];
  const { messages, omitted } = buildRequestMessages(previous, 'q');
  assert.equal(messages.length, 1);
  assert.equal(omitted, 2);
});

test('history never exceeds 16 messages', () => {
  const previous = Array.from({ length: 30 }, (_, i) => turn(String(i), 'u', 'a'));
  const { messages } = buildRequestMessages(previous, 'last');
  assert.ok(messages.length <= 16);
  assert.equal(messages.length % 2, 1);
});

test('titles are single-line and bounded', () => {
  assert.equal(conversationTitle('Xin  chào\nbạn'), 'Xin chào bạn');
  assert.ok(conversationTitle('x'.repeat(100)).length <= 41);
});

test('rename normalizes whitespace, bounds length and rejects empty titles', () => {
  assert.equal(normalizeTitle('  Báo  cáo\nquý 3 '), 'Báo cáo quý 3');
  assert.equal(normalizeTitle('   '), null);
  assert.equal(normalizeTitle('x'.repeat(100)).length, 60);
});

// --- markdown safety ----------------------------------------------------------------------------

test('markdown keeps raw HTML as literal text and never emits HTML nodes', () => {
  const blocks = parseMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['p', 'p'],
  );
  assert.equal(blocks[0].c[0].t, 'text');
  assert.equal(blocks[0].c[0].v, '<script>alert(1)</script>');
});

test('markdown only produces http(s) links', () => {
  const inline = parseInline(
    '[a](javascript:alert(1)) [b](https://example.com/x) [c](data:text/html,x)',
  );
  const links = inline.filter((n) => n.t === 'link');
  assert.deepEqual(
    links.map((l) => l.href),
    ['https://example.com/x'],
  );
});

test('markdown parses code fences, lists, emphasis and tolerates an unclosed fence', () => {
  const blocks = parseMarkdown(
    '# Tiêu đề\n\n- một\n- hai\n\n1. a\n2. b\n\n```py\nprint(1)\n```\n\n**đậm** và `mã`\n\n```js\nlet x',
  );
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['h', 'ul', 'ol', 'code', 'p', 'code'],
  );
  assert.equal(blocks[3].lang, 'py');
  assert.equal(blocks[3].v, 'print(1)');
  assert.equal(blocks[5].v, 'let x');
});

// --- client streaming and error mapping --------------------------------------------------------

function sse(frames, init) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...init,
  });
}

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('streamChat delivers real deltas in order and sends only public fields', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return sse([
      frame('stream.started', { version: '1' }),
      frame('content.delta', { content: 'Xin ' }),
      frame('content.delta', { content: 'chào' }),
      frame('stream.completed', { finish_reason: 'stop' }),
    ]);
  };
  const deltas = [];
  await streamChat([{ role: 'user', content: 'hi' }], new AbortController().signal, (d) =>
    deltas.push(d),
  );
  assert.deepEqual(deltas, ['Xin ', 'chào']);
  assert.equal(sent.url, '/api/v1/chat/completions/stream');
  assert.deepEqual(Object.keys(sent.body).sort(), [
    'generation',
    'messages',
    'thinking',
    'version',
  ]);
  assert.equal(sent.body.thinking.mode, 'disabled');
  assert.ok(!JSON.stringify(sent.body).includes('system'));
});

test('streamChat maps HTTP statuses and in-stream errors to failure kinds', async () => {
  const cases = [
    [400, 'invalid'],
    [413, 'invalid'],
    [422, 'context'],
    [429, 'capacity'],
    [503, 'unavailable'],
    [504, 'timeout'],
    [502, 'server'],
  ];
  for (const [status, kind] of cases) {
    globalThis.fetch = async () => new Response('{}', { status });
    await assert.rejects(
      streamChat([], new AbortController().signal, () => {}),
      (error) => error instanceof ChatError && error.failure.kind === kind,
    );
    assert.equal(failureFromStatus(status), kind);
  }
  assert.equal(failureFromCode('MODEL_UNAVAILABLE'), 'unavailable');
  assert.equal(failureFromCode('CONTEXT_BUDGET_EXCEEDED'), 'context');
  assert.equal(failureFromCode('FIRST_TOKEN_TIMEOUT'), 'timeout');
  assert.equal(failureFromCode('PROVIDER_OVERLOAD'), 'capacity');
  globalThis.fetch = async () =>
    sse([
      frame('stream.started', {}),
      frame('stream.error', { error: { code: 'REQUEST_DEADLINE_EXCEEDED', message: 'x' } }),
    ]);
  await assert.rejects(
    streamChat([], new AbortController().signal, () => {}),
    (error) => error.failure.kind === 'timeout',
  );
});

test('streamChat reports an interrupted stream and network failure', async () => {
  globalThis.fetch = async () => sse([frame('content.delta', { content: 'a' })]);
  await assert.rejects(
    streamChat([], new AbortController().signal, () => {}),
    (error) => error.failure.kind === 'interrupted',
  );
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    streamChat([], new AbortController().signal, () => {}),
    (error) => error.failure.kind === 'network',
  );
});

test('aborting streamChat rejects with the abort and propagates to fetch', async () => {
  const abort = new AbortController();
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.signal;
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
    );
  };
  const pending = streamChat([], abort.signal, () => {});
  abort.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(seen.aborted, true);
});

// --- proxy status passthrough --------------------------------------------------------------------

test('stream proxy preserves safe upstream failure categories without forwarding bodies', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  for (const status of [422, 429, 503, 504]) {
    globalThis.fetch = async () => Response.json({ error: 'secret upstream detail' }, { status });
    const request = new Request('http://127.0.0.1:3000/api/v1/chat/completions/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = await forwardChatRequest(request, true);
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes('secret'));
  }
  globalThis.fetch = async () => Response.json({}, { status: 500 });
  const request = new Request('http://127.0.0.1:3000/api/v1/chat/completions/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal((await forwardChatRequest(request, true)).status, 502);
});

test('streamChat reports server-side history exclusion from context.prepared', async () => {
  globalThis.fetch = async () =>
    sse([
      frame('stream.started', {}),
      frame('context.prepared', { history_turns_included: 1, history_turns_excluded: 2 }),
      frame('content.delta', { content: 'ok' }),
      frame('stream.completed', { finish_reason: 'stop' }),
    ]);
  const seen = [];
  const deltas = [];
  await streamChat(
    [{ role: 'user', content: 'hi' }],
    new AbortController().signal,
    (d) => deltas.push(d),
    (info) => seen.push(info),
  );
  assert.deepEqual(seen, [{ excludedTurns: 2 }]);
  assert.deepEqual(deltas, ['ok']);
  // Malformed values are ignored rather than trusted.
  globalThis.fetch = async () =>
    sse([
      frame('context.prepared', { history_turns_excluded: -1 }),
      frame('context.prepared', { history_turns_excluded: 'x' }),
      frame('stream.completed', {}),
    ]);
  const ignored = [];
  await streamChat(
    [],
    new AbortController().signal,
    () => {},
    (info) => ignored.push(info),
  );
  assert.deepEqual(ignored, []);
});
