import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { forwardChatRequest } from '../src/server/chat-proxy.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.API_BASE_URL;
  delete process.env.CHAT_MAX_BODY_BYTES;
  delete process.env.CHAT_REQUEST_TIMEOUT_MS;
});

function browserRequest(path = '/api/v1/chat/completions', signal) {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'web-chat' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Xin chào' }] }),
    signal,
  });
}

test('server proxy uses only server-side API configuration and preserves correlation', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:3001/api/v1/chat/completions');
    assert.equal(init.headers['X-Request-ID'], 'web-chat');
    assert.ok(Number(init.headers['X-Request-Timeout-Ms']) <= 300000);
    return Response.json(
      { version: '1', request_id: 'web-chat' },
      { headers: { 'X-Request-ID': 'web-chat' } },
    );
  };
  const response = await forwardChatRequest(browserRequest(), false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'web-chat');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
});

test('stream proxy preserves fragmented UTF-8 chunks and cancels its upstream reader', async () => {
  const encoder = new TextEncoder();
  let sourceCancelled = false;
  let upstreamSignal;
  globalThis.fetch = async (_input, init) => {
    upstreamSignal = init.signal;
    let emitted = false;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(encoder.encode('event: content.delta\ndata: {"content":"Xin"}\n\n'));
          }
        },
        cancel() {
          sourceCancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const response = await forwardChatRequest(
    browserRequest('/api/v1/chat/completions/stream'),
    true,
  );
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /content\.delta/);
  await reader.cancel('browser disconnected');
  assert.equal(sourceCancelled, true);
  assert.equal(upstreamSignal.aborted, true);
});

test('stream proxy does not coalesce a complete upstream response', async () => {
  const encoder = new TextEncoder();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: stream.started\ndata: {}\n\n'));
          controller.enqueue(encoder.encode('event: stream.completed\ndata: {}\n\n'));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  const response = await forwardChatRequest(
    browserRequest('/api/v1/chat/completions/stream'),
    true,
  );
  const text = await response.text();
  assert.match(text, /stream\.started/);
  assert.match(text, /stream\.completed/);
});

test('proxy rejects oversized browser bodies and invalid upstream content types', async () => {
  process.env.CHAT_MAX_BODY_BYTES = '1024';
  const oversized = new Request('http://127.0.0.1:3000/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'x'.repeat(2000) }),
  });
  assert.equal((await forwardChatRequest(oversized, false)).status, 413);

  globalThis.fetch = async () => new Response('private upstream body', { status: 200 });
  const invalid = await forwardChatRequest(browserRequest(), false);
  assert.equal(invalid.status, 502);
  assert.doesNotMatch(await invalid.text(), /private upstream/);
});
