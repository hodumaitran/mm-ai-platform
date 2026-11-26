import type { DocumentKind } from '../generated/prisma/client';

export const MEDIA_TYPES: Record<DocumentKind, string> = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TXT: 'text/plain',
};

const EXTENSIONS: Record<string, DocumentKind> = { pdf: 'PDF', docx: 'DOCX', txt: 'TXT' };
const MAX_FILENAME_CHARACTERS = 200;
const SIGNATURE_WINDOW = 1024;

/**
 * Reduce a browser-supplied filename to a safe display name: no directories, control characters or
 * reserved characters. It is only ever used for display and the download name, never for a path.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  let cleaned = '';
  for (const character of base) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159) || '<>:"|?*'.includes(character)) continue;
    cleaned += character;
  }
  cleaned = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 ? cleaned.slice(dot) : '';
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const room = MAX_FILENAME_CHARACTERS - extension.length;
  const safeStem = stem.length > room ? stem.slice(0, Math.max(1, room)) : stem;
  const result = `${safeStem}${extension}`;
  return result === '' || result === extension ? `document${extension}` : result;
}

export function kindFromFilename(filename: string): DocumentKind | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 1) return null;
  return EXTENSIONS[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** Content check that does not trust the extension or the browser MIME type. */
export function signatureMatches(kind: DocumentKind, head: Buffer): boolean {
  if (kind === 'PDF') return head.subarray(0, SIGNATURE_WINDOW).includes('%PDF-');
  if (kind === 'DOCX') return head.length >= 4 && head.readUInt32LE(0) === 0x04034b50;
  return !head.includes(0); // TXT: a NUL byte means binary content
}

export { SIGNATURE_WINDOW };

/** Content-Disposition value for attachments, safe for non-ASCII names (RFC 5987). */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
