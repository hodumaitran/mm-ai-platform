export const MAX_REQUEST_MESSAGES = 16;
export const MAX_MESSAGE_CHARACTERS = 2048;
export const MAX_AGGREGATE_CHARACTERS = 3072;

export type StoredMessage = {
  seq: number;
  role: 'USER' | 'ASSISTANT';
  content: string;
  status: 'GENERATING' | 'COMPLETED' | 'STOPPED' | 'FAILED' | 'INTERRUPTED';
};

export type WireMessage = { role: 'user' | 'assistant'; content: string };

/**
 * Build the model context from persisted history (the database is the only source of truth).
 *
 * Only complete turns are usable: a user message immediately followed by an assistant message that
 * finished (or was stopped after producing text). Failed or empty generations never reach the model.
 * Newest whole turns are kept while the public limits hold; older turns are dropped, never truncated.
 * `omitted` counts usable turns that did not fit.
 */
export function buildContext(
  earlier: readonly StoredMessage[],
  current: string,
): { messages: WireMessage[]; omitted: number } {
  const turns: [StoredMessage, StoredMessage][] = [];
  for (let index = 0; index + 1 < earlier.length; index += 1) {
    const user = earlier[index];
    const assistant = earlier[index + 1];
    if (
      user !== undefined &&
      assistant !== undefined &&
      user.role === 'USER' &&
      assistant.role === 'ASSISTANT' &&
      assistant.seq === user.seq + 1 &&
      (assistant.status === 'COMPLETED' || assistant.status === 'STOPPED') &&
      assistant.content.trim() !== ''
    ) {
      turns.push([user, assistant]);
      index += 1;
    }
  }

  let budget = MAX_AGGREGATE_CHARACTERS - current.length;
  let count = 1;
  const kept: [StoredMessage, StoredMessage][] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) break;
    const [user, assistant] = turn;
    const cost = user.content.length + assistant.content.length;
    if (
      user.content.length > MAX_MESSAGE_CHARACTERS ||
      assistant.content.length > MAX_MESSAGE_CHARACTERS ||
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
  for (const [user, assistant] of kept) {
    messages.push(
      { role: 'user', content: user.content },
      { role: 'assistant', content: assistant.content },
    );
  }
  messages.push({ role: 'user', content: current });
  return { messages, omitted: turns.length - kept.length };
}

export const DEFAULT_TITLE = 'Cuộc trò chuyện mới';

export function titleFrom(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 40 ? `${single.slice(0, 40).trimEnd()}…` : single;
}
