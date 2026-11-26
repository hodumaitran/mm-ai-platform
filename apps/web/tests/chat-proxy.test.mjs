import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { forwardApiRequest } from '../src/server/api-proxy.ts';

const originalFetch = globalThis.fetch;
const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.API_BASE_URL;
  delete process.env.CHAT_MAX_BODY_BYTES;
  delete process.env.CHAT_REQUEST_TIMEOUT_MS;
});

function browser(method, path, { body, headers = {}, signal } = {}) {
  return new Request(`http://127.0.0.1:3000/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Request-ID': 'web-req',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

test('proxy only reaches allow-listed backend routes', async () => {
  let reached = 0;
  globalThis.fetch = async () => {
    reached += 1;
    return Response.json({});
  };
  for (const [method, path] of [
    ['GET', '/health'],
    ['GET', '/chat/completions'],
    ['POST', '/chat/completions/stream'],
    ['DELETE', '/users'],
    ['GET', '/conversations/not-a-uuid/messages'],
    ['GET', `/conversations/${ID}/regenerate`],
    ['GET', '/../../etc/passwd'],
  ]) {
    const response = await forwardApiRequest(browser(method, path));
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(reached, 0);
});

test('proxy forwards only the session cookie, CSRF token and origin, and relays Set-Cookie', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  let sent;
  globalThis.fetch = async (input, init) => {
    sent = { url: String(input), headers: init.headers, method: init.method, body: init.body };
    const headers = new Headers({ 'Content-Type': 'application/json', 'Retry-After': '30' });
    headers.append('Set-Cookie', 'mm_session=abc; HttpOnly; SameSite=Lax; Path=/');
    return new Response(JSON.stringify({ user: { id: '1' } }), { status: 200, headers });
  };
  const response = await forwardApiRequest(
    browser('POST', '/auth/login', {
      body: { email: 'a@b.co', password: 'x' },
      headers: {
        Cookie: 'mm_session=old',
        'X-CSRF-Token': 'csrf',
        Origin: 'http://127.0.0.1:3000',
        Authorization: 'Bearer should-not-pass',
        'X-Internal': 'nope',
      },
    }),
  );
  assert.equal(sent.url, 'http://127.0.0.1:3001/api/v1/auth/login');
  assert.equal(sent.headers.get('cookie'), 'mm_session=old');
  assert.equal(sent.headers.get('x-csrf-token'), 'csrf');
  assert.equal(sent.headers.get('origin'), 'http://127.0.0.1:3000');
  assert.equal(sent.headers.get('authorization'), null);
  assert.equal(sent.headers.get('x-internal'), null);
  assert.equal(sent.headers.get('x-request-id'), 'web-req');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
});

test('proxy preserves upstream status codes and bodies of the backend API', async () => {
  for (const status of [401, 403, 404, 409, 429, 503]) {
    globalThis.fetch = async () => Response.json({ statusCode: status }, { status });
    const response = await forwardApiRequest(browser('GET', '/conversations'));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { statusCode: status });
  }
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal((await forwardApiRequest(browser('DELETE', `/conversations/${ID}`))).status, 204);
});

test('stream route keeps fragmented chunks and cancels the upstream when the browser disconnects', async () => {
  const encoder = new TextEncoder();
  let sourceCancelled = false;
  let upstreamSignal;
  globalThis.fetch = async (_input, init) => {
    upstreamSignal = init.signal;
    assert.ok(Number(init.headers.get('x-request-timeout-ms')) <= 300000);
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
      { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    );
  };
  const response = await forwardApiRequest(
    browser('POST', `/conversations/${ID}/messages`, {
      body: { content: 'hi', clientRequestId: ID },
    }),
  );
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /content\.delta/);
  await reader.cancel('browser disconnected');
  assert.equal(sourceCancelled, true);
  assert.equal(upstreamSignal.aborted, true);
});

test('regenerate accepts an empty body and stream responses are not coalesced', async () => {
  const encoder = new TextEncoder();
  let sent;
  globalThis.fetch = async (_input, init) => {
    sent = init;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: stream.started\ndata: {}\n\n'));
          controller.enqueue(encoder.encode('event: stream.completed\ndata: {}\n\n'));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const response = await forwardApiRequest(browser('POST', `/conversations/${ID}/regenerate`));
  const text = await response.text();
  assert.equal(sent.body, undefined);
  assert.match(text, /stream\.started/);
  assert.match(text, /stream\.completed/);
});

test('proxy rejects oversized bodies, wrong content types and invalid stream responses', async () => {
  process.env.CHAT_MAX_BODY_BYTES = '1024';
  const oversized = browser('POST', '/conversations', { body: { title: 'x'.repeat(2000) } });
  assert.equal((await forwardApiRequest(oversized)).status, 413);
  const text = new Request('http://127.0.0.1:3000/api/v1/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal((await forwardApiRequest(text)).status, 400);

  globalThis.fetch = async () =>
    new Response('private upstream body', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  const invalid = await forwardApiRequest(
    browser('POST', `/conversations/${ID}/messages`, {
      body: { content: 'a', clientRequestId: ID },
    }),
  );
  assert.equal(invalid.status, 502);
  assert.doesNotMatch(await invalid.text(), /private upstream/);

  globalThis.fetch = async () => {
    throw new TypeError('connect ECONNREFUSED 127.0.0.1:3001');
  };
  const down = await forwardApiRequest(browser('GET', '/auth/me'));
  assert.equal(down.status, 502);
  assert.doesNotMatch(await down.text(), /ECONNREFUSED|127\.0\.0\.1/);
});
