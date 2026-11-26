import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { readCookie, sessionCookieName } from './cookies';
import { LoginRateLimiter, retryAfterSeconds } from './login-rate-limiter';

describe('cookies', () => {
  it('uses the __Host- prefix only for secure cookies', () => {
    expect(sessionCookieName(true)).toBe('__Host-mm_session');
    expect(sessionCookieName(false)).toBe('mm_session');
  });

  it('reads one named cookie and rejects empty or oversized values', () => {
    expect(readCookie('a=1; mm_session=abc; b=2', 'mm_session')).toBe('abc');
    expect(readCookie('a=1', 'mm_session')).toBeUndefined();
    expect(readCookie('mm_session=', 'mm_session')).toBeUndefined();
    expect(readCookie(`mm_session=${'x'.repeat(300)}`, 'mm_session')).toBeUndefined();
    expect(readCookie(undefined, 'mm_session')).toBeUndefined();
  });
});

describe('LoginRateLimiter', () => {
  const config = {
    get: (key: string): number => (key === 'LOGIN_MAX_FAILURES' ? 3 : 60),
  } as unknown as ConfigService<Environment, true>;

  it('blocks after the failure budget, reports a retry delay and forgets old failures', () => {
    const limiter = new LoginRateLimiter(config);
    const keys = ['email:a@x.com'];
    limiter.recordFailure(keys, 0);
    limiter.recordFailure(keys, 1000);
    limiter.recordFailure(keys, 2000);
    let caught: unknown;
    try {
      limiter.assertAllowed(keys, 3000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
    expect(retryAfterSeconds(caught as HttpException)).toBe(57);
    expect(() => limiter.assertAllowed(keys, 61_000)).not.toThrow();
  });

  it('clears an account key on success and allows more noise per address', () => {
    const limiter = new LoginRateLimiter(config);
    limiter.recordFailure(['email:a@x.com', 'ip:1.2.3.4'], 0);
    limiter.recordFailure(['email:a@x.com', 'ip:1.2.3.4'], 1);
    limiter.recordFailure(['email:a@x.com', 'ip:1.2.3.4'], 2);
    limiter.reset('email:a@x.com');
    expect(() => limiter.assertAllowed(['email:a@x.com', 'ip:1.2.3.4'], 3)).not.toThrow();
  });
});
