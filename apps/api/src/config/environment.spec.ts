import { validateEnvironment } from './environment';

const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pw@127.0.0.1:5432/app',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('validateEnvironment', () => {
  it('provides loopback development defaults', () => {
    expect(validateEnvironment({ ...REQUIRED })).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 3001,
      API_REQUEST_BODY_LIMIT_BYTES: 65536,
      AI_SERVICE_BASE_URL: 'http://127.0.0.1:8000',
      AI_SERVICE_CONNECT_TIMEOUT_MS: 5000,
      AI_SERVICE_REQUEST_TIMEOUT_MS: 300000,
      AI_SERVICE_MAX_RESPONSE_BYTES: 65536,
      DATABASE_URL: REQUIRED.DATABASE_URL,
      SESSION_SECRET: REQUIRED.SESSION_SECRET,
      SESSION_TTL_SECONDS: 43200,
      SESSION_COOKIE_SECURE: false,
      APP_ALLOWED_ORIGINS: ['http://127.0.0.1:3000', 'http://localhost:3000'],
      LOGIN_MAX_FAILURES: 5,
      LOGIN_WINDOW_SECONDS: 900,
      GENERATION_STALE_SECONDS: 360,
    });
  });

  it.each([0, 65536, 'not-a-port', 3.14])('rejects invalid API_PORT %p', (API_PORT) => {
    expect(() => validateEnvironment({ ...REQUIRED, API_PORT })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => validateEnvironment({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow(
      'NODE_ENV must be development, test, or production',
    );
  });

  it('rejects a non-loopback API_HOST', () => {
    expect(() => validateEnvironment({ ...REQUIRED, API_HOST: '0.0.0.0' })).toThrow(
      'API_HOST must be a loopback address',
    );
  });

  it.each([
    'https://127.0.0.1:8000',
    'http://example.com:8000',
    'http://user:secret@127.0.0.1:8000',
    'http://127.0.0.1:8000/private',
  ])('rejects unsafe AI service origin %s', (AI_SERVICE_BASE_URL) => {
    expect(() => validateEnvironment({ ...REQUIRED, AI_SERVICE_BASE_URL })).toThrow(
      'AI_SERVICE_BASE_URL must be a credential-free loopback HTTP origin',
    );
  });

  it('requires database and session settings, and keeps the database on loopback', () => {
    expect(() => validateEnvironment({ SESSION_SECRET: REQUIRED.SESSION_SECRET })).toThrow(
      'DATABASE_URL',
    );
    expect(() =>
      validateEnvironment({
        ...REQUIRED,
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
      }),
    ).toThrow('loopback');
    expect(() =>
      validateEnvironment({ ...REQUIRED, DATABASE_URL: 'mysql://u@127.0.0.1/app' }),
    ).toThrow('DATABASE_URL');
    expect(() => validateEnvironment({ ...REQUIRED, SESSION_SECRET: 'short' })).toThrow(
      'SESSION_SECRET',
    );
  });

  it('defaults the session cookie to Secure only in production', () => {
    expect(validateEnvironment({ ...REQUIRED, NODE_ENV: 'production' }).SESSION_COOKIE_SECURE).toBe(
      true,
    );
    expect(
      validateEnvironment({ ...REQUIRED, NODE_ENV: 'production', SESSION_COOKIE_SECURE: 'false' })
        .SESSION_COOKIE_SECURE,
    ).toBe(false);
  });
});
