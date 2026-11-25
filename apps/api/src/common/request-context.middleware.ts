import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { recordRequestStart } from '../ai/request-policy';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    recordRequestStart(request);
    const supplied = request.header('X-Request-ID');
    const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-ID', requestId);
    next();
  }
}
