// The session lives in an HttpOnly cookie that scripts cannot read. The only value kept in memory is
// the CSRF token, which the server derives from the session and returns from login and /auth/me.
let csrfToken = '';
let unauthorizedHandler: (() => void) | null = null;

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter: number | null;
  constructor(status: number, retryAfter: number | null = null) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function requestHeaders(method: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hasBody) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

/** An expired or revoked session anywhere in the app sends the user back to the login page. */
export function handleUnauthorized(): void {
  csrfToken = '';
  unauthorizedHandler?.();
}

export async function apiJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options: { body?: unknown; signal?: AbortSignal; sessionOptional?: boolean } = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers: requestHeaders(method, options.body !== undefined),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    void response.body?.cancel();
    if (response.status === 401 && options.sessionOptional !== true) handleUnauthorized();
    const retry = Number(response.headers.get('retry-after'));
    throw new ApiError(response.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
