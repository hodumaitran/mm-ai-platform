export type SseFrame = { event: string; data: unknown };

/** Incremental SSE frame parser for the AI service stream (CRLF-safe, skips malformed JSON). */
export function createSseFrameParser(onFrame: (frame: SseFrame) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      try {
        onFrame({ event, data: JSON.parse(data.join('\n')) as unknown });
      } catch {
        // A malformed frame is ignored rather than trusted.
      }
    }
    // Bound memory if a peer never sends a frame boundary.
    if (buffer.length > 262_144) buffer = '';
  };
}
