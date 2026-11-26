export type WebEnvironment = {
  apiBaseUrl: URL;
  chatRequestTimeoutMs: number;
  chatMaxBodyBytes: number;
  documentMaxBytes: number;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function validateWebEnvironment(input: Record<string, string | undefined>): WebEnvironment {
  const apiBaseUrl = new URL(input.API_BASE_URL ?? 'http://127.0.0.1:3001/api/v1');
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(apiBaseUrl.hostname);
  if (
    apiBaseUrl.protocol !== 'http:' ||
    !loopback ||
    apiBaseUrl.username !== '' ||
    apiBaseUrl.password !== '' ||
    apiBaseUrl.port === '' ||
    apiBaseUrl.search !== '' ||
    apiBaseUrl.hash !== ''
  ) {
    throw new Error('API_BASE_URL must be a credential-free loopback HTTP URL');
  }
  return {
    apiBaseUrl,
    chatRequestTimeoutMs: boundedInteger(
      input.CHAT_REQUEST_TIMEOUT_MS,
      300000,
      'CHAT_REQUEST_TIMEOUT_MS',
      1000,
      3600000,
    ),
    // Must match DOCUMENT_MAX_BYTES in the API and AI_SERVICE_DOCUMENT_MAX_BYTES in the AI service.
    documentMaxBytes: boundedInteger(
      input.DOCUMENT_MAX_BYTES,
      52428800,
      'DOCUMENT_MAX_BYTES',
      1024,
      1073741824,
    ),
    chatMaxBodyBytes: boundedInteger(
      input.CHAT_MAX_BODY_BYTES,
      65536,
      'CHAT_MAX_BODY_BYTES',
      1024,
      1048576,
    ),
  };
}
