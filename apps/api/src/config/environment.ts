import { resolve, sep } from 'node:path';

export type Environment = {
  NODE_ENV: 'development' | 'test' | 'production';
  API_HOST: string;
  API_PORT: number;
  API_REQUEST_BODY_LIMIT_BYTES: number;
  AI_SERVICE_BASE_URL: string;
  AI_SERVICE_CONNECT_TIMEOUT_MS: number;
  AI_SERVICE_REQUEST_TIMEOUT_MS: number;
  AI_SERVICE_MAX_RESPONSE_BYTES: number;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  SESSION_TTL_SECONDS: number;
  SESSION_COOKIE_SECURE: boolean;
  APP_ALLOWED_ORIGINS: string[];
  LOGIN_MAX_FAILURES: number;
  LOGIN_WINDOW_SECONDS: number;
  GENERATION_STALE_SECONDS: number;
  DOCUMENT_STORAGE_DIR: string;
  DOCUMENT_MAX_BYTES: number;
  DOCUMENT_MAX_CONCURRENCY: number;
  DOCUMENT_JOB_LEASE_SECONDS: number;
  DOCUMENT_JOB_TIMEOUT_SECONDS: number;
  DOCUMENT_MAX_ATTEMPTS: number;
  DOCUMENT_POLL_INTERVAL_MS: number;
  DOCUMENT_WORKER_ENABLED: boolean;
  DOCUMENT_ORPHAN_GRACE_SECONDS: number;
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

function parseDatabaseUrl(value: unknown): string {
  const raw = readString(value, '', 'DATABASE_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'postgresql:' || !loopback || url.pathname.length < 2) {
    throw new Error('DATABASE_URL must be a loopback postgresql:// URL with a database name');
  }
  return raw;
}

function parseSessionSecret(value: unknown): string {
  const secret = readString(value, '', 'SESSION_SECRET');
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return secret;
}

function parseBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseOrigins(value: unknown): string[] {
  const raw = readString(
    value,
    'http://127.0.0.1:3000,http://localhost:3000',
    'APP_ALLOWED_ORIGINS',
  );
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const url = new URL(item);
      if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') {
        throw new Error('APP_ALLOWED_ORIGINS must contain origins only');
      }
      return url.origin;
    });
}

function parseStorageDirectory(value: unknown): string {
  const raw = readString(value, './storage', 'DOCUMENT_STORAGE_DIR').trim();
  if (raw === '' || raw.includes(String.fromCharCode(0))) {
    throw new Error('DOCUMENT_STORAGE_DIR must be a filesystem path');
  }
  const resolved = resolve(raw);
  // Uploaded files must never sit under a directory that a web server could publish.
  if (
    resolved
      .split(sep)
      .some((segment) => ['public', 'static', 'www', 'wwwroot'].includes(segment.toLowerCase()))
  ) {
    throw new Error('DOCUMENT_STORAGE_DIR must not be inside a publicly served directory');
  }
  return resolved;
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
    DATABASE_URL: parseDatabaseUrl(input.DATABASE_URL),
    SESSION_SECRET: parseSessionSecret(input.SESSION_SECRET),
    SESSION_TTL_SECONDS: parseInteger(
      input.SESSION_TTL_SECONDS,
      43200,
      'SESSION_TTL_SECONDS',
      60,
      2592000,
    ),
    SESSION_COOKIE_SECURE: parseBoolean(
      input.SESSION_COOKIE_SECURE,
      nodeEnv === 'production',
      'SESSION_COOKIE_SECURE',
    ),
    APP_ALLOWED_ORIGINS: parseOrigins(input.APP_ALLOWED_ORIGINS),
    LOGIN_MAX_FAILURES: parseInteger(input.LOGIN_MAX_FAILURES, 5, 'LOGIN_MAX_FAILURES', 1, 100),
    LOGIN_WINDOW_SECONDS: parseInteger(
      input.LOGIN_WINDOW_SECONDS,
      900,
      'LOGIN_WINDOW_SECONDS',
      1,
      86400,
    ),
    // Must exceed the AI request deadline, so a live generation is never declared stale.
    GENERATION_STALE_SECONDS: parseInteger(
      input.GENERATION_STALE_SECONDS,
      360,
      'GENERATION_STALE_SECONDS',
      10,
      7200,
    ),
    DOCUMENT_STORAGE_DIR: parseStorageDirectory(input.DOCUMENT_STORAGE_DIR),
    // Configurable safety limits, not verified capacity. Must match the web proxy and the AI service.
    DOCUMENT_MAX_BYTES: parseInteger(
      input.DOCUMENT_MAX_BYTES,
      52428800,
      'DOCUMENT_MAX_BYTES',
      1024,
      1073741824,
    ),
    DOCUMENT_MAX_CONCURRENCY: parseInteger(
      input.DOCUMENT_MAX_CONCURRENCY,
      1,
      'DOCUMENT_MAX_CONCURRENCY',
      1,
      8,
    ),
    DOCUMENT_JOB_LEASE_SECONDS: parseInteger(
      input.DOCUMENT_JOB_LEASE_SECONDS,
      90,
      'DOCUMENT_JOB_LEASE_SECONDS',
      3,
      3600,
    ),
    // Must exceed the AI service's own processing timeout (default 600 s).
    DOCUMENT_JOB_TIMEOUT_SECONDS: parseInteger(
      input.DOCUMENT_JOB_TIMEOUT_SECONDS,
      660,
      'DOCUMENT_JOB_TIMEOUT_SECONDS',
      1,
      14400,
    ),
    DOCUMENT_MAX_ATTEMPTS: parseInteger(
      input.DOCUMENT_MAX_ATTEMPTS,
      3,
      'DOCUMENT_MAX_ATTEMPTS',
      1,
      10,
    ),
    DOCUMENT_POLL_INTERVAL_MS: parseInteger(
      input.DOCUMENT_POLL_INTERVAL_MS,
      2000,
      'DOCUMENT_POLL_INTERVAL_MS',
      50,
      60000,
    ),
    DOCUMENT_WORKER_ENABLED: parseBoolean(
      input.DOCUMENT_WORKER_ENABLED,
      true,
      'DOCUMENT_WORKER_ENABLED',
    ),
    DOCUMENT_ORPHAN_GRACE_SECONDS: parseInteger(
      input.DOCUMENT_ORPHAN_GRACE_SECONDS,
      600,
      'DOCUMENT_ORPHAN_GRACE_SECONDS',
      1,
      86400,
    ),
  };
}
