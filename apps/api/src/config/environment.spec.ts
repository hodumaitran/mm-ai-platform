import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('provides loopback development defaults', () => {
    expect(validateEnvironment({})).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 3001,
      API_REQUEST_BODY_LIMIT_BYTES: 65536,
      AI_SERVICE_BASE_URL: 'http://127.0.0.1:8000',
      AI_SERVICE_CONNECT_TIMEOUT_MS: 5000,
      AI_SERVICE_REQUEST_TIMEOUT_MS: 300000,
      AI_SERVICE_MAX_RESPONSE_BYTES: 65536,
    });
  });

  it.each([0, 65536, 'not-a-port', 3.14])('rejects invalid API_PORT %p', (API_PORT) => {
    expect(() => validateEnvironment({ API_PORT })).toThrow(
      'API_PORT must be an integer between 1 and 65535',
    );
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'staging' })).toThrow(
      'NODE_ENV must be development, test, or production',
    );
  });

  it('rejects a non-loopback API_HOST', () => {
    expect(() => validateEnvironment({ API_HOST: '0.0.0.0' })).toThrow(
      'API_HOST must be a loopback address',
    );
  });

  it.each([
    'https://127.0.0.1:8000',
    'http://example.com:8000',
    'http://user:secret@127.0.0.1:8000',
    'http://127.0.0.1:8000/private',
  ])('rejects unsafe AI service origin %s', (AI_SERVICE_BASE_URL) => {
    expect(() => validateEnvironment({ AI_SERVICE_BASE_URL })).toThrow(
      'AI_SERVICE_BASE_URL must be a credential-free loopback HTTP origin',
    );
  });
});
