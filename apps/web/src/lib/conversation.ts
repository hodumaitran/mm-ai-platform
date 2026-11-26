export const MAX_MESSAGE_CHARACTERS = 2048;
export const MAX_AGGREGATE_CHARACTERS = 3072;
export const MAX_REQUEST_MESSAGES = 16;

export type WireMessage = { role: 'user' | 'assistant'; content: string };

export type TurnStatus = 'streaming' | 'done' | 'stopped' | 'error';

export type ChatFailureKind =
  | 'invalid'
  | 'context'
  | 'capacity'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'server'
  | 'interrupted';

export type ChatFailure = { kind: ChatFailureKind };

export type Turn = {
  id: string;
  user: string;
  assistant: string;
  status: TurnStatus;
  error?: ChatFailure;
  /** Earlier turns that were not part of this request's model context (client or server limits). */
  omitted?: number;
};

export type Conversation = { id: string; title: string; turns: Turn[] };

export function validateDraft(text: string): 'ok' | 'empty' | 'too-long' {
  if (text.trim().length === 0) return 'empty';
  return text.length > MAX_MESSAGE_CHARACTERS ? 'too-long' : 'ok';
}

/**
 * Build the request messages for the next user message from completed earlier turns.
 * Only newest-first whole turns that fit the public limits are sent, so the context never exceeds
 * what the API accepts; nothing is truncated inside a message. `omitted` counts earlier turns that
 * were left out.
 */
export function buildRequestMessages(
  previous: readonly Turn[],
  draft: string,
): { messages: WireMessage[]; omitted: number } {
  const usable = previous.filter(
    (turn) => (turn.status === 'done' || turn.status === 'stopped') && turn.assistant.trim() !== '',
  );
  let budget = MAX_AGGREGATE_CHARACTERS - draft.length;
  let count = 1;
  const kept: Turn[] = [];
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const turn = usable[index];
    if (turn === undefined) break;
    const cost = turn.user.length + turn.assistant.length;
    if (
      turn.user.length > MAX_MESSAGE_CHARACTERS ||
      turn.assistant.length > MAX_MESSAGE_CHARACTERS ||
      cost > budget ||
      count + 2 > MAX_REQUEST_MESSAGES
    ) {
      break;
    }
    kept.unshift(turn);
    budget -= cost;
    count += 2;
  }
  const messages: WireMessage[] = [];
  for (const turn of kept) {
    messages.push(
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant },
    );
  }
  messages.push({ role: 'user', content: draft });
  return { messages, omitted: usable.length - kept.length };
}

export const MAX_TITLE_CHARACTERS = 60;

/** Normalize a user-entered conversation title; `null` means it is not acceptable. */
export function normalizeTitle(text: string): string | null {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length === 0) return null;
  return single.length > MAX_TITLE_CHARACTERS ? single.slice(0, MAX_TITLE_CHARACTERS) : single;
}

export function conversationTitle(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 40 ? `${single.slice(0, 40).trimEnd()}…` : single;
}
