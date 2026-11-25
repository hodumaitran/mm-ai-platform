export type Environment = {
  NODE_ENV: 'development' | 'test' | 'production';
  API_HOST: string;
  API_PORT: number;
  API_REQUEST_BODY_LIMIT_BYTES: number;
  AI_SERVICE_BASE_URL: string;
  AI_SERVICE_CONNECT_TIMEOUT_MS: number;
  AI_SERVICE_REQUEST_TIMEOUT_MS: number;
  AI_SERVICE_MAX_RESPONSE_BYTES: number;
};

function parseNodeEnvironment(value: unknown): Environment['NODE_ENV'] {
  const nodeEnvironment = readString(value, 'development', 'NODE_ENV');
  switch (nodeEnvironment) {
    case 'development':
    case 'test':
    case 'production':
      return nodeEnvironment;
    default:
      throw new Error('NODE_ENV must be development, test, or production');
  }
}

function parsePort(value: unknown): number {
  const port = Number(value ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseInteger(
  value: unknown,
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

function parseLoopbackOrigin(value: unknown): string {
  const raw = readString(value, 'http://127.0.0.1:8000', 'AI_SERVICE_BASE_URL');
  const url = new URL(raw);
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.username !== '' ||
    url.password !== '' ||
    url.port === '' ||
    !['', '/'].includes(url.pathname) ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('AI_SERVICE_BASE_URL must be a credential-free loopback HTTP origin');
  }
  return url.origin;
}

function readString(value: unknown, fallback: string, name: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const nodeEnv = parseNodeEnvironment(input.NODE_ENV);
  const host = readString(input.API_HOST, '127.0.0.1', 'API_HOST').trim();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('API_HOST must be a loopback address');
  }
  return {
    NODE_ENV: nodeEnv,
    API_HOST: host,
    API_PORT: parsePort(input.API_PORT),
    API_REQUEST_BODY_LIMIT_BYTES: parseInteger(
      input.API_REQUEST_BODY_LIMIT_BYTES,
      65536,
      'API_REQUEST_BODY_LIMIT_BYTES',
      1024,
      1048576,
    ),
    AI_SERVICE_BASE_URL: parseLoopbackOrigin(input.AI_SERVICE_BASE_URL),
    AI_SERVICE_CONNECT_TIMEOUT_MS: parseInteger(
      input.AI_SERVICE_CONNECT_TIMEOUT_MS,
      5000,
      'AI_SERVICE_CONNECT_TIMEOUT_MS',
      100,
      60000,
    ),
    AI_SERVICE_REQUEST_TIMEOUT_MS: parseInteger(
      input.AI_SERVICE_REQUEST_TIMEOUT_MS,
      300000,
      'AI_SERVICE_REQUEST_TIMEOUT_MS',
      1000,
      3600000,
    ),
    AI_SERVICE_MAX_RESPONSE_BYTES: parseInteger(
      input.AI_SERVICE_MAX_RESPONSE_BYTES,
      65536,
      'AI_SERVICE_MAX_RESPONSE_BYTES',
      1024,
      1048576,
    ),
  };
}
