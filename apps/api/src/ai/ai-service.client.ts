import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Environment } from '../config/environment';
import type { ChatCompletionDto, ChatCompletionResponse } from './chat.dto';

export type UpstreamRequestContext = {
  requestId: string;
  timeoutMs: number;
  signal: AbortSignal;
};

@Injectable()
export class AiServiceClient {
  private readonly baseUrl: URL;
  private readonly connectTimeoutMs: number;
  private readonly maximumResponseBytes: number;

  constructor(config: ConfigService<Environment, true>) {
    this.baseUrl = new URL(config.get('AI_SERVICE_BASE_URL', { infer: true }));
    this.connectTimeoutMs = config.get('AI_SERVICE_CONNECT_TIMEOUT_MS', { infer: true });
    this.maximumResponseBytes = config.get('AI_SERVICE_MAX_RESPONSE_BYTES', { infer: true });
  }

  async complete(
    payload: ChatCompletionDto,
    context: UpstreamRequestContext,
  ): Promise<ChatCompletionResponse> {
    const response = await this.post('/v1/chat/completions', payload, context);
    await this.assertSuccessful(response);
    const contentType = response.headers['content-type'] ?? '';
    if (!contentType.startsWith('application/json')) {
      response.destroy();
      throw new BadGatewayException('Invalid AI service response');
    }
    const body = await collectBounded(response, this.maximumResponseBytes);
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new BadGatewayException('Invalid AI service response');
    }
    if (!isChatCompletionResponse(value)) {
      throw new BadGatewayException('Invalid AI service response');
    }
    return value;
  }

  async stream(
    payload: ChatCompletionDto,
    context: UpstreamRequestContext,
  ): Promise<IncomingMessage> {
    const response = await this.post('/v1/chat/completions/stream', payload, context);
    await this.assertSuccessful(response);
    const contentType = response.headers['content-type'] ?? '';
    if (!contentType.startsWith('text/event-stream')) {
      response.destroy();
      throw new BadGatewayException('Invalid AI service stream');
    }
    return response;
  }

  private post(
    path: string,
    payload: ChatCompletionDto,
    context: UpstreamRequestContext,
  ): Promise<IncomingMessage> {
    const body = Buffer.from(JSON.stringify(payload));
    const url = new URL(path, this.baseUrl);
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined;
      let receivedResponse: IncomingMessage | undefined;
      const totalTimer = setTimeout(() => {
        receivedResponse?.destroy(new Error('request deadline exceeded'));
        upstream.destroy(new Error('request deadline exceeded'));
      }, context.timeoutMs);
      const abort = (): void => {
        receivedResponse?.destroy(new Error('request cancelled'));
        upstream.destroy(new Error('request cancelled'));
      };
      const cleanup = (): void => {
        clearTimeout(totalTimer);
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
        }
        context.signal.removeEventListener('abort', abort);
      };
      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (context.signal.aborted) {
          reject(new HttpException('Request cancelled', 499));
        } else if (error.message === 'request deadline exceeded') {
          reject(new GatewayTimeoutException('AI service request timed out'));
        } else if (error.message === 'connection timeout') {
          reject(new GatewayTimeoutException('AI service connection timed out'));
        } else {
          reject(new BadGatewayException('AI service connection failed'));
        }
      };
      const upstream: ClientRequest = httpRequest(
        url,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Cache-Control': 'no-store',
            'Content-Length': body.byteLength,
            'Content-Type': 'application/json',
            'X-Request-ID': context.requestId,
            'X-Request-Timeout-Ms': context.timeoutMs,
          },
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          settled = true;
          receivedResponse = response;
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
          }
          response.once('close', cleanup);
          response.once('end', cleanup);
          resolve(response);
        },
      );
      upstream.once('socket', (socket: Socket) => {
        if (!socket.connecting) {
          return;
        }
        connectTimer = setTimeout(
          () => upstream.destroy(new Error('connection timeout')),
          this.connectTimeoutMs,
        );
        socket.once('connect', () => {
          if (connectTimer !== undefined) {
            clearTimeout(connectTimer);
          }
        });
      });
      upstream.once('error', fail);
      context.signal.addEventListener('abort', abort, { once: true });
      if (context.signal.aborted) {
        abort();
        return;
      }
      upstream.end(body);
    });
  }

  private async assertSuccessful(response: IncomingMessage): Promise<void> {
    const status = response.statusCode ?? HttpStatus.BAD_GATEWAY;
    if (status >= 200 && status < 300) {
      return;
    }
    await collectBounded(response, this.maximumResponseBytes).catch(() => undefined);
    const safeStatus = [400, 413, 415, 422, 429, 503, 504].includes(status)
      ? status
      : HttpStatus.BAD_GATEWAY;
    throw new HttpException('AI service request failed', safeStatus);
  }
}

async function collectBounded(stream: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      stream.destroy();
      throw new BadGatewayException('AI service returned an invalid body chunk');
    }
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximumBytes) {
      stream.destroy();
      throw new BadGatewayException('AI service response exceeded the configured limit');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 0);
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  if (!isRecord(value) || !isRecord(value.message) || !isRecord(value.usage)) {
    return false;
  }
  return (
    value.version === '1' &&
    typeof value.request_id === 'string' &&
    typeof value.model === 'string' &&
    value.message.role === 'assistant' &&
    typeof value.message.content === 'string' &&
    value.message.content.length > 0 &&
    typeof value.finish_reason === 'string' &&
    isNullableCount(value.usage.prompt_tokens) &&
    isNullableCount(value.usage.completion_tokens) &&
    isNullableCount(value.usage.total_tokens)
  );
}
