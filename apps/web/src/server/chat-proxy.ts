import { randomUUID } from 'node:crypto';
import { validateWebEnvironment } from './environment.ts';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export async function forwardChatRequest(request: Request, stream: boolean): Promise<Response> {
  const environment = validateWebEnvironment(process.env);
  const requestId = selectRequestId(request.headers.get('X-Request-ID'));
  const started = performance.now();
  let body: Uint8Array;
  try {
    body = await readBoundedBody(request, environment.chatMaxBodyBytes);
  } catch (error) {
    return safeError(error instanceof BodyTooLargeError ? 413 : 400, requestId);
  }
  const remaining = Math.max(
    1,
    environment.chatRequestTimeoutMs - Math.ceil(performance.now() - started),
  );
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, remaining);
  timer.unref();
  try {
    const suffix = stream ? 'chat/completions/stream' : 'chat/completions';
    const upstream = await fetch(new URL(suffix, ensureTrailingSlash(environment.apiBaseUrl)), {
      method: 'POST',
      body: new TextDecoder().decode(body),
      cache: 'no-store',
      headers: {
        Accept: stream ? 'text/event-stream' : 'application/json',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
        'X-Request-Timeout-Ms': String(remaining),
      },
      signal: controller.signal,
    });
    const expectedType = stream ? 'text/event-stream' : 'application/json';
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith(expectedType) || upstream.body === null) {
      controller.abort();
      cleanup(timer, request, abort);
      return safeError(502, requestId);
    }
    const responseBody = managedStream(upstream.body, controller, timer, request, abort);
    const headers = new Headers({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Type': stream ? 'text/event-stream; charset=utf-8' : 'application/json',
      'X-Request-ID': upstream.headers.get('X-Request-ID') ?? requestId,
    });
    if (stream) {
      headers.set('X-Accel-Buffering', 'no');
    }
    return new Response(responseBody, { status: upstream.status, headers });
  } catch {
    cleanup(timer, request, abort);
    return safeError(controller.signal.aborted ? 504 : 502, requestId);
  }
}

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new Error('invalid content type');
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new BodyTooLargeError();
  }
  if (request.body === null) {
    throw new Error('missing body');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
