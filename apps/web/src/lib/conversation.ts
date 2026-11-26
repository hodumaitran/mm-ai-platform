export const MAX_MESSAGE_CHARACTERS = 2048;
export const MAX_TITLE_CHARACTERS = 60;

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'error';

export type ChatFailureKind =
  | 'invalid'
  | 'context'
  | 'capacity'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'server'
  | 'interrupted'
  | 'conflict'
  | 'notfound'
  | 'unauthorized';

export type ChatFailure = { kind: ChatFailureKind };

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  status: TurnStatus;
  error?: ChatFailure;
  /** Earlier turns that were not part of this answer's model context (server decides). */
  omitted?: number;
  /** Idempotency key of an in-session submission; restored turns have none. */
  clientRequestId?: string;
};

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export type ServerMessage = {
  id: string;
  seq: number;
  role: 'USER' | 'ASSISTANT';
  content: string;
  status: 'GENERATING' | 'COMPLETED' | 'STOPPED' | 'FAILED' | 'INTERRUPTED';
  errorCode: string | null;
};

export function validateDraft(text: string): 'ok' | 'empty' | 'too-long' {
  if (text.trim().length === 0) return 'empty';
  return text.length > MAX_MESSAGE_CHARACTERS ? 'too-long' : 'ok';
}

/** Normalize a user-entered conversation title; `null` means it is not acceptable. */
export function normalizeTitle(text: string): string | null {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return null;
  return single.length > MAX_TITLE_CHARACTERS ? single.slice(0, MAX_TITLE_CHARACTERS) : single;
}

export function failureFromStoredCode(
  code: string | null,
  status: ServerMessage['status'],
): ChatFailure {
  if (status === 'INTERRUPTED') return { kind: 'interrupted' };
  const http = /^UPSTREAM_HTTP_(\d{3})$/.exec(code ?? '');
  if (http?.[1] !== undefined) {
    const value = Number(http[1]);
    if (value === 422) return { kind: 'context' };
    if (value === 429) return { kind: 'capacity' };
    if (value === 503) return { kind: 'unavailable' };
    if (value === 504) return { kind: 'timeout' };
  }
  switch (code) {
    case 'REQUEST_DEADLINE_EXCEEDED':
    case 'FIRST_TOKEN_TIMEOUT':
    case 'STREAM_INACTIVITY_TIMEOUT':
    case 'PROVIDER_TIMEOUT':
      return { kind: 'timeout' };
    case 'PROVIDER_OVERLOAD':
    case 'ADMISSION_TIMEOUT':
      return { kind: 'capacity' };
    case 'MODEL_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_CONNECTION_FAILURE':
    case 'CAPABILITY_UNAVAILABLE':
      return { kind: 'unavailable' };
    case 'CONTEXT_BUDGET_EXCEEDED':
    case 'PROMPT_BUDGET_EXCEEDED':
      return { kind: 'context' };
    case 'UPSTREAM_ENDED':
    case 'SERVER_RESTART':
    case 'STALE_GENERATION':
      return { kind: 'interrupted' };
    default:
      return { kind: 'server' };
  }
}

/** Pair persisted messages (ordered by seq) into display turns. */
export function messagesToTurns(messages: readonly ServerMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index];
    if (user === undefined || user.role !== 'USER') continue;
    const reply = messages[index + 1];
    const assistant = reply !== undefined && reply.role === 'ASSISTANT' ? reply : undefined;
    if (assistant !== undefined) index += 1;
    const base = { id: user.id, user: user.content, assistant: assistant?.content ?? '' };
    if (assistant === undefined) {
      turns.push({ ...base, status: 'error', error: { kind: 'interrupted' } });
    } else if (assistant.status === 'COMPLETED') {
      turns.push({ ...base, status: 'done' });
    } else if (assistant.status === 'STOPPED') {
      turns.push({ ...base, status: 'stopped' });
    } else {
      turns.push({
        ...base,
        status: 'error',
        error: failureFromStoredCode(
          assistant.errorCode,
          assistant.status === 'GENERATING' ? 'INTERRUPTED' : assistant.status,
        ),
      });
    }
  }
  return turns;
}
