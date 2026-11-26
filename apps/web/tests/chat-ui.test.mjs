import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ChatError,
  failureFromCode,
  failureFromStatus,
  streamReply,
} from '../src/lib/chat-client.ts';
import {
  MAX_MESSAGE_CHARACTERS,
  messagesToTurns,
  normalizeTitle,
  validateDraft,
} from '../src/lib/conversation.ts';
import {
  MAX_UPLOAD_BYTES,
  errorText,
  formatBytes,
  isActive,
  uploadErrorText,
  validateFile,
} from '../src/lib/documents.ts';
import { parseInline, parseMarkdown } from '../src/lib/markdown.ts';
import { createSseParser } from '../src/lib/sse.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

// --- input limits -------------------------------------------------------------------------------

test('draft validation rejects empty and oversized messages', () => {
  assert.equal(validateDraft('   \n'), 'empty');
  assert.equal(validateDraft('x'.repeat(MAX_MESSAGE_CHARACTERS)), 'ok');
  assert.equal(validateDraft('x'.repeat(MAX_MESSAGE_CHARACTERS + 1)), 'too-long');
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
const CONVERSATION = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const noSignal = () => new AbortController().signal;
const regenerate = { kind: 'regenerate' };

test('streamReply sends only the new text and idempotency key, with CSRF, to the owned conversation', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return sse([
      frame('stream.started', { version: '1' }),
      frame('conversation.state', { title: 'Tiêu đề', omitted_turns: 1 }),
      frame('context.prepared', { history_turns_excluded: 2 }),
      frame('content.delta', { content: 'Xin ' }),
      frame('content.delta', { content: 'chào' }),
      frame('stream.completed', { finish_reason: 'stop' }),
    ]);
  };
  const deltas = [];
  const omitted = [];
  const titles = [];
  await streamReply(
    CONVERSATION,
    { kind: 'send', content: 'hi', clientRequestId: 'req-1' },
    noSignal(),
    {
      onDelta: (d) => deltas.push(d),
      onOmitted: (n) => omitted.push(n),
      onState: ({ title }) => titles.push(title),
    },
  );
  assert.deepEqual(deltas, ['Xin ', 'chào']);
  // API-side omission (1) and AI-side exclusion (2) are summed.
  assert.deepEqual(omitted, [1, 3]);
  assert.deepEqual(titles, ['Tiêu đề']);
  assert.equal(sent.url, `/api/v1/conversations/${CONVERSATION}/messages`);
  assert.equal(sent.init.credentials, 'same-origin');
  assert.deepEqual(Object.keys(sent.body).sort(), ['clientRequestId', 'content']);
  assert.ok(!JSON.stringify(sent.body).includes('system'));
  assert.ok('X-CSRF-Token' in sent.init.headers);
});

test('streamReply regenerate posts without a body to the regenerate route', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return sse([frame('stream.completed', {})]);
  };
  await streamReply(CONVERSATION, regenerate, noSignal(), { onDelta: () => {} });
  assert.equal(sent.url, `/api/v1/conversations/${CONVERSATION}/regenerate`);
  assert.equal(sent.init.body, undefined);
});

test('streamReply maps HTTP statuses and in-stream errors to failure kinds', async () => {
  const cases = [
    [400, 'invalid'],
    [401, 'unauthorized'],
    [404, 'notfound'],
    [409, 'conflict'],
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
      streamReply(CONVERSATION, regenerate, noSignal(), { onDelta: () => {} }),
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
    streamReply(CONVERSATION, regenerate, noSignal(), { onDelta: () => {} }),
    (error) => error.failure.kind === 'timeout',
  );
});

test('streamReply reports an interrupted stream and network failure', async () => {
  globalThis.fetch = async () => sse([frame('content.delta', { content: 'a' })]);
  await assert.rejects(
    streamReply(CONVERSATION, regenerate, noSignal(), { onDelta: () => {} }),
    (error) => error.failure.kind === 'interrupted',
  );
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    streamReply(CONVERSATION, regenerate, noSignal(), { onDelta: () => {} }),
    (error) => error.failure.kind === 'network',
  );
});

test('aborting streamReply rejects with the abort and propagates to fetch', async () => {
  const abort = new AbortController();
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init.signal;
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
    );
  };
  const pending = streamReply(CONVERSATION, regenerate, abort.signal, { onDelta: () => {} });
  abort.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(seen.aborted, true);
});

test('streamReply ignores malformed omitted counts instead of trusting them', async () => {
  globalThis.fetch = async () =>
    sse([
      frame('conversation.state', { omitted_turns: -1 }),
      frame('context.prepared', { history_turns_excluded: 'x' }),
      frame('stream.completed', {}),
    ]);
  const seen = [];
  await streamReply(CONVERSATION, regenerate, noSignal(), {
    onDelta: () => {},
    onOmitted: (n) => seen.push(n),
  });
  assert.deepEqual(seen, []);
});

// --- restoring persisted conversations --------------------------------------------------------

const stored = (seq, role, content, status = 'COMPLETED', errorCode = null) => ({
  id: `m${seq}`,
  seq,
  role,
  content,
  status,
  errorCode,
});

test('persisted messages are restored as turns in order with accurate states', () => {
  const turns = messagesToTurns([
    stored(1, 'USER', 'một'),
    stored(2, 'ASSISTANT', 'trả lời một'),
    stored(3, 'USER', 'hai'),
    stored(4, 'ASSISTANT', 'dở dang', 'STOPPED'),
    stored(5, 'USER', 'ba'),
    stored(6, 'ASSISTANT', '', 'FAILED', 'UPSTREAM_HTTP_503'),
    stored(7, 'USER', 'bốn'),
    stored(8, 'ASSISTANT', 'một phần', 'INTERRUPTED', 'SERVER_RESTART'),
    stored(9, 'USER', 'năm'),
    stored(10, 'ASSISTANT', '', 'FAILED', 'MODEL_UNAVAILABLE'),
  ]);
  assert.deepEqual(
    turns.map((t) => [t.user, t.status, t.error?.kind]),
    [
      ['một', 'done', undefined],
      ['hai', 'stopped', undefined],
      ['ba', 'error', 'unavailable'],
      ['bốn', 'error', 'interrupted'],
      ['năm', 'error', 'unavailable'],
    ],
  );
  assert.equal(turns[1].assistant, 'dở dang');
  assert.ok(turns.every((t) => t.clientRequestId === undefined));
});

test('a user message without an assistant reply is shown as interrupted, not dropped', () => {
  const turns = messagesToTurns([stored(1, 'USER', 'lẻ')]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].error.kind, 'interrupted');
});

// --- document library helpers -----------------------------------------------------------------

test('file validation mirrors the server rules (type, empty, size)', () => {
  assert.equal(validateFile({ name: 'a.pdf', size: 10 }), null);
  assert.equal(validateFile({ name: 'Báo cáo.DOCX', size: 10 }), null);
  assert.equal(validateFile({ name: 'a.txt', size: MAX_UPLOAD_BYTES }), null);
  assert.match(validateFile({ name: 'a.exe', size: 10 }), /PDF, DOCX và TXT/);
  assert.match(validateFile({ name: 'noextension', size: 10 }), /PDF, DOCX và TXT/);
  assert.match(validateFile({ name: 'a.pdf', size: MAX_UPLOAD_BYTES + 1 }), /vượt quá 50/);
  assert.equal(validateFile({ name: 'a.pdf', size: 0 }), 'Tệp rỗng.');
});

test('sizes, statuses and error codes render as safe Vietnamese text', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(50 * 1024 * 1024), '50.0 MiB');
  assert.equal(isActive('PENDING') && isActive('PROCESSING'), true);
  assert.equal(isActive('READY') || isActive('FAILED') || isActive('OCR_REQUIRED'), false);
  assert.match(errorText('ENCRYPTED_DOCUMENT'), /mật khẩu/);
  assert.match(errorText('OCR_REQUIRED'), /OCR/);
  assert.match(errorText('SOMETHING_NEW'), /không thành công/);
  assert.equal(errorText(null), '');
  assert.match(uploadErrorText(413, undefined), /vượt quá/);
  assert.match(uploadErrorText(415, 'CONTENT_MISMATCH'), /không khớp/);
  assert.match(uploadErrorText(415, 'UNSUPPORTED_FORMAT'), /PDF, DOCX/);
  assert.equal(uploadErrorText(400, 'EMPTY_FILE'), 'Tệp rỗng.');
  assert.doesNotMatch(uploadErrorText(500, undefined), /undefined|Error/);
});
