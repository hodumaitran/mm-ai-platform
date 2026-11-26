import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const status = exceptionStatus(exception);
    const requestId =
      typeof request.headers['x-request-id'] === 'string'
        ? request.headers['x-request-id']
        : 'unavailable';
    response.setHeader('X-Request-ID', requestId);
    response.status(status).json({
      ...publicCode(exception),
      error: status === 500 ? 'Internal Server Error' : 'Request failed',
      path: request.path,
      requestId,
      statusCode: status,
      timestamp: new Date().toISOString(),
    });
  }
}

function exceptionStatus(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (
    typeof exception === 'object' &&
    exception !== null &&
    'status' in exception &&
    exception.status === HttpStatus.PAYLOAD_TOO_LARGE
  ) {
    return HttpStatus.PAYLOAD_TOO_LARGE;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

/** A stable machine-readable reason (for example FILE_TOO_LARGE) when the thrower supplied one. */
function publicCode(exception: unknown): { code?: string } {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === 'object' && 'code' in body) {
      const code = body.code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/.test(code)) return { code };
    }
  }
  return {};
}
