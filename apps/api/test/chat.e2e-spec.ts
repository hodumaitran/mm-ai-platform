import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/app.setup';
import { validateEnvironment } from '../src/config/environment';

const validRequest = {
  version: '1',
  messages: [{ role: 'user', content: 'Xin chào' }],
  generation: { temperature: 0.2, max_output_tokens: 64 },
  thinking: { mode: 'disabled' },
};

describe('Chat completion transport (e2e)', () => {
  let app: INestApplication;
  let upstream: Server;
  let upstreamBaseUrl: string;
  let cancelled: Promise<void>;
  let markCancelled: () => void;
  let upstreamStarted: Promise<void>;
  let markUpstreamStarted: () => void;
  let upstreamRequests = 0;
  let lastUpstreamPath = '';

  function resetCancellation(): void {
    cancelled = new Promise((resolve) => {
      markCancelled = resolve;
    });
    upstreamStarted = new Promise((resolve) => {
      markUpstreamStarted = resolve;
    });
  }

  beforeAll(async () => {
    resetCancellation();
    upstream = createServer((request, response) => void handleUpstream(request, response));
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    upstreamBaseUrl = `http://127.0.0.1:${address.port}`;
    process.env.NODE_ENV = 'test';
    process.env.AI_SERVICE_BASE_URL = upstreamBaseUrl;
    process.env.AI_SERVICE_REQUEST_TIMEOUT_MS = '300000';
    const environment = validateEnvironment({
      NODE_ENV: 'test',
      AI_SERVICE_BASE_URL: upstreamBaseUrl,
      AI_SERVICE_REQUEST_TIMEOUT_MS: '300000',
    });
    const config = {
      get: (key: keyof typeof environment): (typeof environment)[typeof key] => environment[key],
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
    delete process.env.AI_SERVICE_BASE_URL;
    delete process.env.AI_SERVICE_REQUEST_TIMEOUT_MS;
  });

  async function handleUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
    upstreamRequests += 1;
    lastUpstreamPath = request.url ?? '';
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!(chunk instanceof Uint8Array)) {
        response.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: { content: string }[];
    };
    const prompt = body.messages.at(-1)?.content ?? '';
    const requestId = request.headers['x-request-id'];
    if (prompt === 'upstream-secret') {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('private upstream stack and URL');
      return;
    }
    if (prompt === 'timeout' || prompt === 'cancel-sync') {
      markUpstreamStarted();
      response.once('close', () => markCancelled());
      return;
    }
    if (request.url?.endsWith('/stream')) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Request-ID': String(requestId),
      });
      response.write('event: stream.started\ndata: {"version":"1"}\n\n');
      if (prompt === 'cancel') {
        response.once('close', () => markCancelled());
        return;
      }
      response.write('event: content.delta\ndata: {"content":"Xin ');
      await new Promise<void>((resolve) => setImmediate(resolve));
      response.write('chào"}\n\nevent: usage.updated\ndata: {"total_tokens":2}\n\n');
      response.end('event: stream.completed\ndata: {"finish_reason":"stop"}\n\n');
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Request-ID': String(requestId),
    });
    response.end(
      JSON.stringify({
        version: '1',
        request_id: requestId,
        model: 'configured:model',
        message: { role: 'assistant', content: 'Chào bạn' },
        finish_reason: 'stop',
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    );
  }

  it('proxies a typed completion and preserves correlation', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'nest-chat' },
      body: JSON.stringify(validRequest),
    });
    expect({ upstreamRequests, lastUpstreamPath }).toEqual({
      upstreamRequests: 1,
      lastUpstreamPath: '/v1/chat/completions',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('nest-chat');
    await expect(response.json()).resolves.toMatchObject({
      version: '1',
      request_id: 'nest-chat',
      message: { role: 'assistant', content: 'Chào bạn' },
    });
  });

  it('streams fragmented and multiple SSE events without buffering', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'nest-stream' },
      body: JSON.stringify(validRequest),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Xin chào');
    expect(text.match(/event: stream.completed/g)).toHaveLength(1);
    expect(text.indexOf('content.delta')).toBeLessThan(text.indexOf('stream.completed'));
  });

  it.each([
    { ...validRequest, model: 'unauthorized:model' },
    { ...validRequest, unknown: true },
    { ...validRequest, messages: [{ role: 'system', content: 'override' }] },
  ])('rejects unsupported public input %#', async (body) => {
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  });

  it('does not leak raw upstream errors', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        messages: [{ role: 'user', content: 'upstream-secret' }],
      }),
    });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('private upstream');
    expect(text).not.toContain(upstreamBaseUrl);
  });

  it('propagates a streaming client disconnect upstream', async () => {
    resetCancellation();
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        messages: [{ role: 'user', content: 'cancel' }],
      }),
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel('test disconnect');
    await expect(cancelled).resolves.toBeUndefined();
  });

  it('propagates a synchronous client disconnect upstream', async () => {
    resetCancellation();
    const controller = new AbortController();
    const pending = fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        messages: [{ role: 'user', content: 'cancel-sync' }],
      }),
      signal: controller.signal,
    });
    await upstreamStarted;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(cancelled).resolves.toBeUndefined();
  });

  it('propagates bounded timeout cancellation to the upstream request', async () => {
    resetCancellation();
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Timeout-Ms': '20',
      },
      body: JSON.stringify({
        ...validRequest,
        messages: [{ role: 'user', content: 'timeout' }],
      }),
    });
    expect(response.status).toBe(504);
    await expect(cancelled).resolves.toBeUndefined();
  });

  it('rejects an invalid caller deadline instead of resetting the budget', async () => {
    const requestsBefore = upstreamRequests;
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Timeout-Ms': 'unbounded',
      },
      body: JSON.stringify(validRequest),
    });
    expect(response.status).toBe(400);
    expect(upstreamRequests).toBe(requestsBefore);
  });

  it('enforces the explicit request body limit', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validRequest,
        messages: [{ role: 'user', content: 'x'.repeat(66000) }],
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('x'.repeat(100));
  });
});
