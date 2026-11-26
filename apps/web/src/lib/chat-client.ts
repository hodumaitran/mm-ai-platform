import type { ChatFailure, ChatFailureKind, WireMessage } from './conversation.ts';
import { createSseParser } from './sse.ts';

export class ChatError extends Error {
  readonly failure: ChatFailure;
  constructor(kind: ChatFailureKind) {
    super(kind);
    this.failure = { kind };
  }
}

const GENERATION = { temperature: 0.3, max_output_tokens: 512 } as const;

export function failureFromStatus(status: number): ChatFailureKind {
  if (status === 400 || status === 413 || status === 415) return 'invalid';
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

/** Stream one assistant reply from the same-origin route. Abort through `signal` to stop it. */
export async function streamChat(
  messages: readonly WireMessage[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onContext?: (info: { excludedTurns: number }) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/v1/chat/completions/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        version: '1',
        messages,
        generation: GENERATION,
        thinking: { mode: 'disabled' },
      }),
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ChatError('network');
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new ChatError(failureFromStatus(response.status));
  }
  if (response.body === null) throw new ChatError('server');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let terminal = false;
  let failure: ChatError | null = null;
  const parse = createSseParser(({ event, data }) => {
    const payload = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >;
    if (event === 'content.delta' && typeof payload.content === 'string') {
      onDelta(payload.content);
    } else if (event === 'context.prepared') {
      const excluded = payload.history_turns_excluded;
      if (typeof excluded === 'number' && Number.isInteger(excluded) && excluded >= 0) {
        onContext?.({ excludedTurns: excluded });
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
