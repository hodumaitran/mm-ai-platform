import { randomUUID } from 'node:crypto';
import { validateWebEnvironment } from './environment.ts';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHORT_TIMEOUT_MS = 30_000;

type Route = { method: string; pattern: RegExp; stream: boolean };

/**
 * The only backend paths the browser may reach. NestJS remains the authentication and
 * authorization authority; this list just keeps the same-origin proxy from being a generic tunnel.
 */
const ROUTES: readonly Route[] = [
  { method: 'POST', pattern: /^auth\/login$/, stream: false },
  { method: 'POST', pattern: /^auth\/logout$/, stream: false },
  { method: 'GET', pattern: /^auth\/me$/, stream: false },
  { method: 'GET', pattern: /^users$/, stream: false },
  { method: 'POST', pattern: /^users$/, stream: false },
  { method: 'PATCH', pattern: new RegExp(`^users/${UUID}$`), stream: false },
  { method: 'GET', pattern: /^conversations$/, stream: false },
  { method: 'POST', pattern: /^conversations$/, stream: false },
  { method: 'GET', pattern: new RegExp(`^conversations/${UUID}/messages$`), stream: false },
  { method: 'PATCH', pattern: new RegExp(`^conversations/${UUID}$`), stream: false },
  { method: 'DELETE', pattern: new RegExp(`^conversations/${UUID}$`), stream: false },
  { method: 'POST', pattern: new RegExp(`^conversations/${UUID}/messages$`), stream: true },
  { method: 'POST', pattern: new RegExp(`^conversations/${UUID}/regenerate$`), stream: true },
];

// Request headers that are forwarded; everything else (including Host) is dropped.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'cookie', 'origin', 'x-csrf-token'];

export async function forwardApiRequest(request: Request): Promise<Response> {
  const environment = validateWebEnvironment(process.env);
  const requestId = selectRequestId(request.headers.get('X-Request-ID'));
  const prefix = '/api/v1/';
  const pathname = new URL(request.url).pathname;
  const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
  const route = ROUTES.find(
    (candidate) => candidate.method === request.method && candidate.pattern.test(relative),
  );
  if (route === undefined) {
    return safeError(404, requestId);
  }

  const started = performance.now();
  let body: string | undefined;
  if (request.method === 'POST' || request.method === 'PATCH') {
    try {
      body = await readBoundedBody(request, environment.chatMaxBodyBytes);
    } catch (error) {
      return safeError(error instanceof BodyTooLargeError ? 413 : 400, requestId);
    }
  }
  const budget = route.stream ? environment.chatRequestTimeoutMs : SHORT_TIMEOUT_MS;
  const remaining = Math.max(1, budget - Math.ceil(performance.now() - started));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, remaining);
  timer.unref();

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null && !(name === 'content-type' && body === undefined)) {
      headers.set(name, value);
    }
  }
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Request-ID', requestId);
  if (route.stream) headers.set('X-Request-Timeout-Ms', String(remaining));
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor !== null) headers.set('X-Forwarded-For', forwardedFor.slice(0, 200));

  try {
    const upstream = await fetch(new URL(relative, ensureTrailingSlash(environment.apiBaseUrl)), {
      method: request.method,
      body,
      cache: 'no-store',
      redirect: 'manual',
      headers,
      signal: controller.signal,
    });
    if (route.stream && upstream.ok) {
      const contentType = upstream.headers.get('content-type') ?? '';
      if (!contentType.startsWith('text/event-stream') || upstream.body === null) {
        controller.abort();
        cleanup(timer, request, abort);
        return safeError(502, requestId);
      }
    }
    const responseHeaders = new Headers({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Request-ID': upstream.headers.get('X-Request-ID') ?? requestId,
    });
    const contentType = upstream.headers.get('content-type');
    if (contentType !== null) responseHeaders.set('Content-Type', contentType);
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter)) {
      responseHeaders.set('Retry-After', retryAfter);
    }
    for (const cookie of upstream.headers.getSetCookie()) {
      responseHeaders.append('Set-Cookie', cookie);
    }
    if (route.stream && upstream.ok) responseHeaders.set('X-Accel-Buffering', 'no');
    if (upstream.body === null || upstream.status === 204) {
      cleanup(timer, request, abort);
      return new Response(null, { status: upstream.status, headers: responseHeaders });
    }
    return new Response(managedStream(upstream.body, controller, timer, request, abort), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch {
    cleanup(timer, request, abort);
    return safeError(controller.signal.aborted ? 504 : 502, requestId);
  }
}

async function readBoundedBody(
  request: Request,
  maximumBytes: number,
): Promise<string | undefined> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new BodyTooLargeError();
  }
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new Error('invalid content type');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function managedStream(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  timer: ReturnType<typeof setTimeout>,
  request: Request,
  abort: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup(timer, request, abort);
          target.close();
          return;
        }
        target.enqueue(value);
      } catch (error) {
        cleanup(timer, request, abort);
        target.error(error);
      }
    },
    async cancel(reason) {
      controller.abort();
      cleanup(timer, request, abort);
      await reader.cancel(reason);
    },
  });
}

function cleanup(timer: ReturnType<typeof setTimeout>, request: Request, abort: () => void): void {
  clearTimeout(timer);
  request.signal.removeEventListener('abort', abort);
}

function safeError(status: number, requestId: string): Response {
  return Response.json(
    { error: 'Request failed', requestId, statusCode: status },
    { status, headers: { 'Cache-Control': 'no-store', 'X-Request-ID': requestId } },
  );
}

function selectRequestId(value: string | null): string {
  return value !== null && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

function ensureTrailingSlash(value: URL): URL {
  const normalized = new URL(value);
  normalized.pathname = `${normalized.pathname.replace(/\/$/, '')}/`;
  return normalized;
}

class BodyTooLargeError extends Error {}
