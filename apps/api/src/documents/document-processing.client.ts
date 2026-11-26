import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { Environment } from '../config/environment';
import type { DocumentKind } from '../generated/prisma/client';

export type ChunkRecord = {
  type: 'chunk';
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  section: string | null;
  articles: string[];
  charStart: number;
  charEnd: number;
  estimatedTokens: number;
};
export type SummaryRecord = {
  type: 'summary';
  status: 'READY' | 'PARTIAL' | 'OCR_REQUIRED' | 'FAILED';
  code: string | null;
  metadata: Record<string, unknown>;
};
export type ErrorRecord = { type: 'error'; code: string };
export type ProcessingRecord = ChunkRecord | SummaryRecord | ErrorRecord;

/** The AI service refused or could not take the document right now: worth retrying later. */
export class ProcessorUnavailableError extends Error {}
/** The call was cancelled by us (deletion, shutdown) or timed out. */
export class ProcessingAbortedError extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(reason);
  }
}

const MAX_LINE_CHARACTERS = 8 * 1024 * 1024;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

/** Client for the private Python document endpoint; the file is streamed, never buffered. */
@Injectable()
export class DocumentProcessingClient {
  private readonly baseUrl: URL;

  constructor(config: ConfigService<Environment, true>) {
    this.baseUrl = new URL(config.get('AI_SERVICE_BASE_URL', { infer: true }));
  }

  async *process(
    filePath: string,
    size: number,
    kind: DocumentKind,
    context: { requestId: string; signal: AbortSignal },
  ): AsyncGenerator<ProcessingRecord> {
    const response = await this.post(filePath, size, kind, context);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    try {
      for await (const chunk of response) {
        buffer += decoder.write(chunk as Buffer);
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const record = parseRecord(line);
          if (record !== null) yield record;
          newline = buffer.indexOf('\n');
        }
        if (buffer.length > MAX_LINE_CHARACTERS) throw new Error('processing line too long');
      }
      const tail = parseRecord(buffer + decoder.end());
      if (tail !== null) yield tail;
    } catch (error) {
      if (context.signal.aborted) throw abortReason(context.signal);
      throw error;
    } finally {
      response.destroy();
    }
  }

  private post(
    filePath: string,
    size: number,
    kind: DocumentKind,
    context: { requestId: string; signal: AbortSignal },
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const source = createReadStream(filePath);
      const upstream = httpRequest(
        new URL('/v1/documents/process', this.baseUrl),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': size,
            'X-Document-Kind': kind.toLowerCase(),
            'X-Request-ID': context.requestId,
          },
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status !== 200) {
            response.resume();
            reject(
              TRANSIENT_STATUSES.has(status)
                ? new ProcessorUnavailableError(`status ${status}`)
                : new Error(`processor rejected the document (${status})`),
            );
            return;
          }
          resolve(response);
        },
      );
      const fail = (error: Error): void => {
        source.destroy();
        upstream.destroy();
        if (context.signal.aborted) reject(abortReason(context.signal));
        else reject(new ProcessorUnavailableError(error.message));
      };
      upstream.once('error', fail);
      source.once('error', (error) => {
        source.destroy();
        upstream.destroy();
        reject(error);
      });
      const onAbort = (): void => {
        source.destroy();
        upstream.destroy();
        reject(abortReason(context.signal));
      };
      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener('abort', onAbort, { once: true });
      upstream.once('close', () => context.signal.removeEventListener('abort', onAbort));
      source.pipe(upstream);
    });
  }
}

function abortReason(signal: AbortSignal): ProcessingAbortedError {
  return new ProcessingAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
}

function parseRecord(line: string): ProcessingRecord | null {
  const text = line.trim();
  if (text === '') return null;
  try {
    const value = JSON.parse(text) as { type?: unknown };
    return value.type === 'chunk' || value.type === 'summary' || value.type === 'error'
      ? (value as ProcessingRecord)
      : null;
  } catch {
    return null;
  }
}
