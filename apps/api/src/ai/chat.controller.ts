import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { once } from 'node:events';
import type { Environment } from '../config/environment';
import { AiServiceClient } from './ai-service.client';
import { ChatCompletionDto, type ChatCompletionResponse } from './chat.dto';
import { boundedRequestTimeout, requestId } from './request-policy';

@Controller('chat/completions')
export class ChatController {
  private readonly maximumTimeoutMs: number;

  constructor(
    private readonly client: AiServiceClient,
    config: ConfigService<Environment, true>,
  ) {
    this.maximumTimeoutMs = config.get('AI_SERVICE_REQUEST_TIMEOUT_MS', { infer: true });
  }

  @Post()
  @HttpCode(200)
  async complete(
    @Body() payload: ChatCompletionDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ChatCompletionResponse> {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      return await this.client.complete(payload, {
        requestId: requestId(request),
        timeoutMs: boundedRequestTimeout(request, this.maximumTimeoutMs),
        signal: abortController.signal,
      });
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
    }
  }

  @Post('stream')
  async stream(
    @Body() payload: ChatCompletionDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const upstream = await this.client.stream(payload, {
        requestId: requestId(request),
        timeoutMs: boundedRequestTimeout(request, this.maximumTimeoutMs),
        signal: abortController.signal,
      });
      response.status(upstream.statusCode ?? 200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.setHeader('X-Accel-Buffering', 'no');
      response.setHeader('X-Request-ID', requestId(request));
      response.flushHeaders();
      for await (const chunk of upstream) {
        if (!response.write(chunk)) {
          await once(response, 'drain');
        }
      }
      response.off('close', abort);
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      throw error;
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
      abortController.abort();
    }
  }
}
