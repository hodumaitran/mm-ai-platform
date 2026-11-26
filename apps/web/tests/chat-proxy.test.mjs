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

// --- documents -------------------------------------------------------------------------------

function multipart(size, headers = {}) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(size).fill(65)]), 'a.txt');
  const request = new Request('http://127.0.0.1:3000/api/v1/documents', {
    method: 'POST',
    headers,
    body: form,
  });
  return request;
}

test('document upload is streamed to the API with cookies and CSRF, never buffered as JSON', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = { url: String(input), init };
    const received = [];
    for await (const chunk of init.body) received.push(chunk);
    seen.bytes = received.reduce((sum, c) => sum + c.byteLength, 0);
    return Response.json({ id: 'x' }, { status: 201 });
  };
  const request = multipart(5000, { Cookie: 'mm_session=abc', 'X-CSRF-Token': 'tok' });
  const response = await forwardApiRequest(request);
  assert.equal(response.status, 201);
  assert.equal(seen.url, 'http://127.0.0.1:3001/api/v1/documents');
  assert.equal(seen.init.duplex, 'half');
  assert.match(seen.init.headers.get('content-type'), /^multipart\/form-data; boundary=/);
  assert.equal(seen.init.headers.get('cookie'), 'mm_session=abc');
  assert.equal(seen.init.headers.get('x-csrf-token'), 'tok');
  assert.ok(seen.bytes >= 5000);
});

test('document upload enforces the size limit before and while streaming', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  process.env.DOCUMENT_MAX_BYTES = '2048';
  let reached = 0;
  globalThis.fetch = async (_input, init) => {
    reached += 1;
    for await (const piece of init.body) void piece; // drain
    return Response.json({});
  };
  // Declared size over the limit is rejected without contacting the API.
  const declared = multipart(2 * 1024 * 1024 + 10, { 'Content-Length': String(3 * 1024 * 1024) });
  assert.equal((await forwardApiRequest(declared)).status, 413);
  assert.equal(reached, 0);
  // An undeclared (chunked) body is cut off when it crosses the limit.
  const chunked = new Request('http://127.0.0.1:3000/api/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.close();
      },
    }),
    duplex: 'half',
  });
  assert.equal((await forwardApiRequest(chunked)).status, 413);
  delete process.env.DOCUMENT_MAX_BYTES;
});

test('document upload rejects non-multipart bodies and the download keeps attachment headers', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001/api/v1';
  globalThis.fetch = async () => {
    throw new Error('must not be called');
  };
  const json = new Request('http://127.0.0.1:3000/api/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal((await forwardApiRequest(json)).status, 415);
  const id = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  globalThis.fetch = async () =>
    new Response('PDFBYTES', {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="a.pdf"',
        'Content-Length': '8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Internal-Secret': 'must-not-leak',
      },
    });
  const download = await forwardApiRequest(browser('GET', `/documents/${id}/download`));
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="a.pdf"');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('x-internal-secret'), null);
  assert.equal(await download.text(), 'PDFBYTES');
  for (const [method, path] of [
    ['PUT', `/documents/${id}`],
    ['GET', '/documents/not-a-uuid'],
    ['GET', `/documents/${id}/file`],
    ['POST', `/documents/${id}/process`],
  ]) {
    assert.equal((await forwardApiRequest(browser(method, path))).status, 404, `${method} ${path}`);
  }
});
