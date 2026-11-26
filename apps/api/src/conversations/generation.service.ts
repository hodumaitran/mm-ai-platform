import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { once } from 'node:events';
import { AiServiceClient } from '../ai/ai-service.client';
import { boundedRequestTimeout, requestId } from '../ai/request-policy';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { Prisma, type MessageStatus } from '../generated/prisma/client';
import { DEFAULT_TITLE, buildContext, titleFrom, type WireMessage } from './context-history';
import { createSseFrameParser } from './sse-frames';

export type GenerationInput =
  { kind: 'send'; content: string; clientRequestId: string } | { kind: 'regenerate' };

export type PreparedGeneration = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  messages: WireMessage[];
  omittedTurns: number;
  title: string;
};

type Outcome = { status: Exclude<MessageStatus, 'GENERATING'>; errorCode: string | null };

// Server-owned generation settings: the browser cannot choose them.
const GENERATION = { temperature: 0.3, max_output_tokens: 512 } as const;
const FLUSH_INTERVAL_MS = 2000;
const MAX_STORED_CHARACTERS = 65_536;
const HISTORY_WINDOW = 40;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

@Injectable()
export class GenerationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(GenerationService.name);
  private readonly active = new Map<string, { conversationId: string; abort: AbortController }>();
  private readonly staleMs: number;
  private readonly maximumTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: AiServiceClient,
    config: ConfigService<Environment, true>,
  ) {
    this.staleMs = config.get('GENERATION_STALE_SECONDS', { infer: true }) * 1000;
    this.maximumTimeoutMs = config.get('AI_SERVICE_REQUEST_TIMEOUT_MS', { infer: true });
  }

  /** A restart ends every in-flight generation of this (single) process: record that honestly. */
  async onApplicationBootstrap(): Promise<void> {
    const result = await this.prisma.message.updateMany({
      where: { status: 'GENERATING' },
      data: { status: 'INTERRUPTED', errorCode: 'SERVER_RESTART' },
    });
    if (result.count > 0) this.logger.warn(`Marked ${result.count} generations as interrupted`);
  }

  abortConversation(conversationId: string): void {
    for (const entry of this.active.values()) {
      if (entry.conversationId === conversationId) entry.abort.abort();
    }
  }

  /**
   * Short transaction, no inference inside: lock the owned conversation, reject concurrent
   * generations, persist the user message (idempotently) and a GENERATING assistant row, and build
   * the context from stored history.
   */
  async prepare(
    userId: string,
    conversationId: string,
    input: GenerationInput,
  ): Promise<PreparedGeneration> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM conversations
          WHERE id = ${conversationId}::uuid AND "userId" = ${userId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException();

        const now = new Date();
        await tx.message.updateMany({
          where: {
            conversationId,
            status: 'GENERATING',
            generationStartedAt: { lt: new Date(now.getTime() - this.staleMs) },
          },
          data: { status: 'INTERRUPTED', errorCode: 'STALE_GENERATION' },
        });
        const inFlight = await tx.message.findFirst({
          where: { conversationId, status: 'GENERATING' },
          select: { id: true },
        });
        if (inFlight !== null) throw new ConflictException();

        const last = await tx.message.findFirst({
          where: { conversationId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        const conversation = await tx.conversation.findUniqueOrThrow({
          where: { id: conversationId },
          select: { title: true },
        });

        let userMessage: { id: string; seq: number; content: string };
        let assistantId: string;
        if (input.kind === 'send') {
          const existing = await tx.message.findUnique({
            where: {
              conversationId_clientRequestId: {
                conversationId,
                clientRequestId: input.clientRequestId,
              },
            },
          });
          if (existing === null) {
            const seq = (last?.seq ?? 0) + 1;
            userMessage = await tx.message.create({
              data: {
                conversationId,
                seq,
                role: 'USER',
                content: input.content,
                clientRequestId: input.clientRequestId,
              },
              select: { id: true, seq: true, content: true },
            });
            const assistant = await tx.message.create({
              data: {
                conversationId,
                seq: seq + 1,
                role: 'ASSISTANT',
                content: '',
                status: 'GENERATING',
                generationStartedAt: now,
              },
              select: { id: true },
            });
            assistantId = assistant.id;
          } else {
            // Retry of the same submission: reuse the stored user message, never duplicate the turn.
            const latest = (last?.seq ?? 0) === existing.seq + 1;
            const assistant = await tx.message.findUnique({
              where: { conversationId_seq: { conversationId, seq: existing.seq + 1 } },
              select: { id: true, status: true },
            });
            if (
              existing.content !== input.content ||
              !latest ||
              assistant === null ||
              assistant.status === 'COMPLETED'
            ) {
              throw new ConflictException();
            }
            await this.reset(tx, assistant.id, now);
            userMessage = existing;
            assistantId = assistant.id;
          }
        } else {
          const pair = await tx.message.findMany({
            where: { conversationId },
            orderBy: { seq: 'desc' },
            take: 2,
          });
          const [assistant, user] = pair;
          if (
            assistant === undefined ||
            user === undefined ||
            assistant.role !== 'ASSISTANT' ||
            user.role !== 'USER'
          ) {
            throw new ConflictException();
          }
          await this.reset(tx, assistant.id, now);
          userMessage = user;
          assistantId = assistant.id;
        }

        const earlier = await tx.message.findMany({
          where: { conversationId, seq: { lt: userMessage.seq } },
          orderBy: { seq: 'desc' },
          take: HISTORY_WINDOW,
          select: { seq: true, role: true, content: true, status: true },
        });
        earlier.reverse();
        const context = buildContext(earlier, userMessage.content);

        let title = conversation.title;
        if (title === DEFAULT_TITLE && (last?.seq ?? 0) === 0)
          title = titleFrom(userMessage.content);
        await tx.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: now, title },
        });
        return {
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantId,
          messages: context.messages,
          omittedTurns: context.omitted,
          title,
        };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException();
      }
      throw error;
    }
  }

  /** Streams the reply to the browser while accumulating it; the outcome is always persisted. */
  async run(prepared: PreparedGeneration, request: Request, response: Response): Promise<void> {
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    request.once('aborted', onClose);
    response.once('close', onClose);
    this.active.set(prepared.assistantMessageId, {
      conversationId: prepared.conversationId,
      abort,
    });

    let content = '';
    let outcome: Outcome | null = null;
    let headersSent = false;
    let failure: unknown;
    let lastFlush = Date.now();
    const parse = createSseFrameParser(({ event, data }) => {
      const payload = (typeof data === 'object' && data !== null ? data : {}) as Record<
        string,
        unknown
      >;
      if (event === 'content.delta' && typeof payload.content === 'string') {
        if (content.length < MAX_STORED_CHARACTERS) content += payload.content;
      } else if (event === 'stream.completed') {
        outcome = { status: 'COMPLETED', errorCode: null };
      } else if (event === 'stream.error') {
        const code = (payload.error as { code?: unknown } | undefined)?.code;
        outcome = {
          status: 'FAILED',
          errorCode: typeof code === 'string' && ERROR_CODE.test(code) ? code : 'STREAM_ERROR',
        };
      }
    });

    try {
      const upstream = await this.client.stream(
        {
          version: '1',
          messages: prepared.messages,
          generation: GENERATION,
          thinking: { mode: 'disabled' },
        },
        {
          requestId: requestId(request),
          timeoutMs: boundedRequestTimeout(request, this.maximumTimeoutMs),
          signal: abort.signal,
        },
      );
      upstream.setEncoding('utf8');
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.setHeader('X-Accel-Buffering', 'no');
      response.setHeader('X-Request-ID', requestId(request));
      response.flushHeaders();
      headersSent = true;
      response.write(
        sseEvent('conversation.state', {
          version: '1',
          user_message_id: prepared.userMessageId,
          assistant_message_id: prepared.assistantMessageId,
          title: prepared.title,
          omitted_turns: prepared.omittedTurns,
        }),
      );
      for await (const chunk of upstream as AsyncIterable<string>) {
        if (!response.write(chunk)) {
          await Promise.race([once(response, 'drain'), once(response, 'close')]);
        }
        parse(chunk);
        if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) {
          lastFlush = Date.now();
          await this.flush(prepared.assistantMessageId, content);
        }
      }
    } catch (error) {
      failure = error;
    }

    const settled = outcome as Outcome | null;
    const final: Outcome =
      settled ??
      (abort.signal.aborted
        ? { status: 'STOPPED', errorCode: null }
        : failure instanceof HttpException
          ? { status: 'FAILED', errorCode: `UPSTREAM_HTTP_${failure.getStatus()}` }
          : headersSent
            ? { status: 'INTERRUPTED', errorCode: 'UPSTREAM_ENDED' }
            : { status: 'FAILED', errorCode: 'UPSTREAM_ERROR' });
    try {
      await this.finish(prepared, content, final);
    } finally {
      this.active.delete(prepared.assistantMessageId);
      request.off('aborted', onClose);
      response.off('close', onClose);
    }
    if (!headersSent) {
      if (failure instanceof Error) throw failure;
      throw new ConflictException();
    }
    if (!response.writableEnded && !response.destroyed) response.end();
  }

  private reset(tx: Prisma.TransactionClient, id: string, now: Date): Promise<unknown> {
    return tx.message.update({
      where: { id },
      data: {
        status: 'GENERATING',
        content: '',
        errorCode: null,
        generationStartedAt: now,
        updatedAt: now,
      },
    });
  }

  private async flush(id: string, content: string): Promise<void> {
    try {
      await this.prisma.message.updateMany({
        where: { id, status: 'GENERATING' },
        data: { content, updatedAt: new Date() },
      });
    } catch {
      this.logger.warn('Partial generation flush failed');
    }
  }

  private async finish(
    prepared: PreparedGeneration,
    content: string,
    outcome: Outcome,
  ): Promise<void> {
    try {
      // Guarded by status: a generation already recovered as stale is never overwritten.
      await this.prisma.message.updateMany({
        where: { id: prepared.assistantMessageId, status: 'GENERATING' },
        data: {
          content,
          status: outcome.status,
          errorCode: outcome.errorCode,
          updatedAt: new Date(),
        },
      });
      await this.prisma.conversation.updateMany({
        where: { id: prepared.conversationId },
        data: { updatedAt: new Date() },
      });
    } catch {
      this.logger.error(`Could not persist generation outcome for ${prepared.assistantMessageId}`);
    }
  }
}

function sseEvent(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
