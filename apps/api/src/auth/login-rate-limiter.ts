import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';

type Bucket = { failures: number[] };

/**
 * In-memory failed-login limiter (single API process). Keys are the normalized email and the client
 * address, so one account cannot be brute-forced and one client cannot spray many accounts.
 * A success clears only the email key.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(config: ConfigService<Environment, true>) {
    this.maxFailures = config.get('LOGIN_MAX_FAILURES', { infer: true });
    this.windowMs = config.get('LOGIN_WINDOW_SECONDS', { infer: true }) * 1000;
  }

  /** Throws 429 (with the retry delay) when any key has used up its failure budget. */
  assertAllowed(keys: readonly string[], now = Date.now()): void {
    for (const key of keys) {
      const bucket = this.prune(key, now);
      // The address key tolerates more noise (shared NAT) than a single account.
      const limit = key.startsWith('ip:') ? this.maxFailures * 4 : this.maxFailures;
      if (bucket.failures.length >= limit) {
        const oldest = bucket.failures[0] ?? now;
        const retryAfter = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, retryAfter },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  recordFailure(keys: readonly string[], now = Date.now()): void {
    for (const key of keys) {
      const bucket = this.prune(key, now);
      bucket.failures.push(now);
      this.buckets.set(key, bucket);
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private prune(key: string, now: number): Bucket {
    const bucket = this.buckets.get(key) ?? { failures: [] };
    bucket.failures = bucket.failures.filter((time) => now - time < this.windowMs);
    if (bucket.failures.length === 0) this.buckets.delete(key);
    return bucket;
  }
}

export function retryAfterSeconds(exception: HttpException): number {
  const body = exception.getResponse();
  if (typeof body === 'object' && 'retryAfter' in body) {
    return Number(body.retryAfter);
  }
  return 1;
}
