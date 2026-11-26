export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'hr' };

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
const FENCE_OPEN = /^\s{0,3}```\s*([A-Za-z0-9_+-]*)\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;

/**
 * Parse a small Markdown subset into a data tree. The output never contains raw HTML: every piece of
 * source text stays a plain string, and only http(s) links are produced. Rendering is the caller's job.
 */
export function parseInline(source: string, depth = 0): Inline[] {
  const result: Inline[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index;
    if (index > last) result.push({ t: 'text', v: source.slice(last, index) });
    if (match[1] !== undefined) {
      result.push({ t: 'code', v: match[1].slice(1, -1) });
    } else if (match[2] !== undefined) {
      const inner = match[2].slice(2, -2);
      result.push({
        t: 'strong',
        c: depth < 3 ? parseInline(inner, depth + 1) : [{ t: 'text', v: inner }],
      });
    } else if (match[3] !== undefined) {
      const inner = match[3].slice(1, -1);
      result.push({
        t: 'em',
        c: depth < 3 ? parseInline(inner, depth + 1) : [{ t: 'text', v: inner }],
      });
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const label = match[4].slice(1, match[4].indexOf(']('));
      result.push({ t: 'link', href: match[5], c: [{ t: 'text', v: label }] });
    }
    last = index + match[0].length;
  }
  if (last < source.length) result.push({ t: 'text', v: source.slice(last) });
  return result;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ t: 'p', c: parseInline(paragraph.join('\n')) });
      paragraph = [];
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({
        t: 'h',
        level: (heading[1] ?? '').length as 1 | 2 | 3 | 4,
        c: parseInline(heading[2] ?? ''),
      });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      flush();
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i] ?? '');
        if (item === null) break;
        items.push(parseInline(item[1] ?? ''));
        i += 1;
      }
      i -= 1;
      blocks.push(ordered ? { t: 'ol', items } : { t: 'ul', items });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flush();
      const body: string[] = [quote[1] ?? ''];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1] ?? '')) {
        i += 1;
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
      }
      blocks.push({ t: 'quote', c: parseInline(body.join('\n')) });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}
