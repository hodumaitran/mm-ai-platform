/** `__Host-` binds the cookie to the exact host over HTTPS; plain name for local HTTP development. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-mm_session' : 'mm_session';
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value.length > 0 && value.length <= 256 ? value : undefined;
    }
  }
  return undefined;
}
