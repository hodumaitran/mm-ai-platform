import { createSseFrameParser, type SseFrame } from './sse-frames';

describe('createSseFrameParser', () => {
  it('reassembles frames split at arbitrary boundaries and handles CRLF', () => {
    const frames: SseFrame[] = [];
    const feed = createSseFrameParser((frame) => frames.push(frame));
    const text =
      'event: content.delta\r\ndata: {"content":"Xin chào"}\r\n\r\n: keepalive\n\nevent: stream.completed\ndata: {"a":1}\n\n';
    for (const piece of text.match(/[\s\S]{1,4}/g) ?? []) feed(piece);
    expect(frames).toEqual([
      { event: 'content.delta', data: { content: 'Xin chào' } },
      { event: 'stream.completed', data: { a: 1 } },
    ]);
  });

  it('skips malformed JSON and incomplete trailing frames', () => {
    const frames: SseFrame[] = [];
    const feed = createSseFrameParser((frame) => frames.push(frame));
    feed('event: x\ndata: {bad\n\nevent: y\ndata: {"ok":true}\n\nevent: z\ndata: {"partial"');
    expect(frames).toEqual([{ event: 'y', data: { ok: true } }]);
  });
});
