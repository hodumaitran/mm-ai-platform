import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('provides loopback development defaults', () => {
    expect(validateEnvironment({})).toEqual({
      NODE_ENV: 'development',
      API_HOST: '127.0.0.1',
      API_PORT: 3001,
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

  it('rejects an empty API_HOST', () => {
    expect(() => validateEnvironment({ API_HOST: '  ' })).toThrow('API_HOST must not be empty');
  });
});
