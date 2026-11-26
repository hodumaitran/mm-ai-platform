export type SseEvent = { event: string; data: unknown };

/**
 * Incremental Server-Sent Events parser. Feed decoded text in arbitrary fragments; complete frames
 * (terminated by a blank line) are emitted in order. Frames with invalid JSON data are skipped.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);
      if (parsed !== null) onEvent(parsed);
      boundary = buffer.indexOf('\n\n');
    }
    if (buffer.length > 1_048_576) buffer = '';
  };
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    return null;
  }
}
