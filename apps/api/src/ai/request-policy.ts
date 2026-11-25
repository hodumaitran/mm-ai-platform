import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

const MINIMUM_TIMEOUT_MS = 1;
const requestStartTimes = new WeakMap<Request, number>();

export function recordRequestStart(request: Request): void {
  requestStartTimes.set(request, performance.now());
}

export function boundedRequestTimeout(request: Request, maximumMs: number): number {
  const supplied = request.header('X-Request-Timeout-Ms');
  const started = requestStartTimes.get(request) ?? performance.now();
  const elapsed = Math.max(0, Math.ceil(performance.now() - started));
  if (supplied === undefined) return Math.max(MINIMUM_TIMEOUT_MS, maximumMs - elapsed);
  if (!/^\d+$/.test(supplied)) {
    throw new BadRequestException('Invalid request timeout');
  }
  const parsed = Number(supplied);
  if (!Number.isSafeInteger(parsed) || parsed < MINIMUM_TIMEOUT_MS) {
    throw new BadRequestException('Invalid request timeout');
  }
  return Math.max(MINIMUM_TIMEOUT_MS, Math.min(parsed, maximumMs) - elapsed);
}

export function requestId(request: Request): string {
  const value = request.headers['x-request-id'];
  return typeof value === 'string' ? value : 'unavailable';
}
