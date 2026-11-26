import { buildContext, titleFrom, type StoredMessage } from './context-history';

const turn = (
  index: number,
  user: string,
  assistant: string,
  status: StoredMessage['status'] = 'COMPLETED',
): StoredMessage[] => [
  { seq: index * 2 + 1, role: 'USER', content: user, status: 'COMPLETED' },
  { seq: index * 2 + 2, role: 'ASSISTANT', content: assistant, status },
];

describe('buildContext', () => {
  it('keeps role alternation and ends with the current user message', () => {
    const { messages, omitted } = buildContext(
      [...turn(0, 'a', 'b'), ...turn(1, 'c', 'd')],
      'next',
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(messages.at(-1)?.content).toBe('next');
    expect(omitted).toBe(0);
  });

  it('never sends failed, interrupted, generating or empty assistant turns', () => {
    const history = [
      ...turn(0, 'a', 'b', 'FAILED'),
      ...turn(1, 'c', 'partial', 'STOPPED'),
      ...turn(2, 'e', '', 'STOPPED'),
      ...turn(3, 'g', 'h', 'INTERRUPTED'),
    ];
    const { messages } = buildContext(history, 'now');
    expect(messages).toEqual([
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'now' },
    ]);
  });

  it('drops the oldest whole turns, never truncating, when the aggregate limit is reached', () => {
    const big = 'x'.repeat(1000);
    const { messages, omitted } = buildContext([...turn(0, big, big), ...turn(1, big, big)], 'hi');
    expect(omitted).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(3072);
  });

  it('stops at an over-long assistant reply instead of skipping it', () => {
    const { messages, omitted } = buildContext(
      [...turn(0, 'a', 'b'), ...turn(1, 'c', 'y'.repeat(2049))],
      'q',
    );
    expect(messages).toHaveLength(1);
    expect(omitted).toBe(2);
  });

  it('never exceeds 16 messages', () => {
    const history = Array.from({ length: 30 }, (_, i) => turn(i, 'u', 'a')).flat();
    const { messages } = buildContext(history, 'last');
    expect(messages.length).toBeLessThanOrEqual(16);
    expect(messages.length % 2).toBe(1);
  });
});

describe('titleFrom', () => {
  it('is single-line and bounded', () => {
    expect(titleFrom('Xin  chào\nbạn')).toBe('Xin chào bạn');
    expect(titleFrom('x'.repeat(100)).length).toBeLessThanOrEqual(41);
  });
});
