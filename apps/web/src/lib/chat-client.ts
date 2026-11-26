import { handleUnauthorized, requestHeaders } from './api.ts';
import type { ChatFailure, ChatFailureKind } from './conversation.ts';
import { createSseParser } from './sse.ts';

export class ChatError extends Error {
  readonly failure: ChatFailure;
  constructor(kind: ChatFailureKind) {
    super(kind);
    this.failure = { kind };
  }
}

export function failureFromStatus(status: number): ChatFailureKind {
  if (status === 400 || status === 413 || status === 415) return 'invalid';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'notfound';
  if (status === 409) return 'conflict';
  if (status === 422) return 'context';
  if (status === 429) return 'capacity';
  if (status === 503) return 'unavailable';
  if (status === 504) return 'timeout';
  return 'server';
}

export function failureFromCode(code: unknown): ChatFailureKind {
  switch (code) {
    case 'REQUEST_DEADLINE_EXCEEDED':
    case 'FIRST_TOKEN_TIMEOUT':
    case 'STREAM_INACTIVITY_TIMEOUT':
    case 'PROVIDER_TIMEOUT':
      return 'timeout';
    case 'PROVIDER_OVERLOAD':
    case 'ADMISSION_TIMEOUT':
      return 'capacity';
    case 'MODEL_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_CONNECTION_FAILURE':
    case 'CAPABILITY_UNAVAILABLE':
      return 'unavailable';
    case 'CONTEXT_BUDGET_EXCEEDED':
    case 'PROMPT_BUDGET_EXCEEDED':
    case 'UNSUPPORTED_CAPABILITY':
      return 'context';
    case 'INVALID_REQUEST':
    case 'INVALID_COMPLETION_REQUEST':
      return 'invalid';
    default:
      return 'server';
  }
}

export type GenerationRequest =
  { kind: 'send'; content: string; clientRequestId: string } | { kind: 'regenerate' };

export type StreamHandlers = {
  onDelta: (text: string) => void;
  /** Number of earlier turns the server left out of the model context. */
  onOmitted?: (omittedTurns: number) => void;
  onState?: (state: { title: string }) => void;
};

/**
 * Stream one assistant reply for a conversation. The server persists the user message and the
 * answer; the browser only sends the new text (history is read from the database server-side).
 * Abort through `signal` to stop it: the partial answer is kept.
 */
export async function streamReply(
  conversationId: string,
  request: GenerationRequest,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  const base = `/api/v1/conversations/${encodeURIComponent(conversationId)}`;
  const send = request.kind === 'send';
  let response: Response;
  try {
    response = await fetch(send ? `${base}/messages` : `${base}/regenerate`, {
      method: 'POST',
      headers: {
        ...requestHeaders('POST', send),
        Accept: 'text/event-stream',
      },
      body: send
        ? JSON.stringify({ content: request.content, clientRequestId: request.clientRequestId })
        : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatError('network');
  }
  if (!response.ok) {
    void response.body?.cancel();
    if (response.status === 401) handleUnauthorized();
    throw new ChatError(failureFromStatus(response.status));
  }
  if (response.body === null) throw new ChatError('server');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let terminal = false;
  // History left out by the API (public limits) plus history the AI service had to drop (budget).
  let omittedByApi = 0;
  let excludedByAi = 0;
  let failure: ChatError | null = null;
  const parse = createSseParser(({ event, data }) => {
    const payload = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >;
    if (event === 'content.delta' && typeof payload.content === 'string') {
      handlers.onDelta(payload.content);
    } else if (event === 'conversation.state') {
      if (typeof payload.title === 'string') handlers.onState?.({ title: payload.title });
      const omitted = payload.omitted_turns;
      if (typeof omitted === 'number' && Number.isInteger(omitted) && omitted >= 0) {
        omittedByApi = omitted;
        handlers.onOmitted?.(omittedByApi + excludedByAi);
      }
    } else if (event === 'context.prepared') {
      const excluded = payload.history_turns_excluded;
      if (typeof excluded === 'number' && Number.isInteger(excluded) && excluded >= 0) {
        excludedByAi = excluded;
        handlers.onOmitted?.(omittedByApi + excludedByAi);
      }
    } else if (event === 'stream.completed') {
      terminal = true;
    } else if (event === 'stream.error') {
      terminal = true;
      const error = payload.error as { code?: unknown } | undefined;
      failure = new ChatError(failureFromCode(error?.code));
    }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
      if (terminal) break;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatError('interrupted');
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (failure !== null) throw failure;
  if (!terminal) throw new ChatError('interrupted');
}
