import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import busboy from 'busboy';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { Prisma, type DocumentKind, type DocumentStatus } from '../generated/prisma/client';
import {
  MEDIA_TYPES,
  SIGNATURE_WINDOW,
  kindFromFilename,
  sanitizeFilename,
  signatureMatches,
} from './document-files';
import { DocumentProcessorService } from './document-processor.service';
import { DocumentStorageService } from './document-storage.service';

export type DocumentView = {
  id: string;
  originalFilename: string;
  kind: DocumentKind;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  errorCode: string | null;
  extraction: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type ChunkView = {
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

const VIEW = {
  id: true,
  originalFilename: true,
  kind: true,
  mediaType: true,
  sizeBytes: true,
  sha256: true,
  status: true,
  errorCode: true,
  extractionMetadata: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Multipart framing adds a little to the file size; beyond this the request is refused outright.
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

type Stored = Prisma.DocumentGetPayload<{ select: typeof VIEW }>;

function view(row: Stored): DocumentView {
  const { extractionMetadata, ...rest } = row;
  return { ...rest, extraction: extractionMetadata };
}

function problem(
  Exception: new (response: { code: string; message: string }) => Error,
  code: string,
): Error {
  return new Exception({ code, message: code });
}

/** Every query carries the owner id: ownership is enforced at the database query boundary. */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorageService,
    private readonly processor: DocumentProcessorService,
    config: ConfigService<Environment, true>,
  ) {
    this.maxBytes = config.get('DOCUMENT_MAX_BYTES', { infer: true });
  }

  // -- upload ----------------------------------------------------------------------------------

  async ingest(userId: string, request: Request): Promise<DocumentView> {
    if (!/^multipart\/form-data\s*;/i.test(request.headers['content-type'] ?? '')) {
      throw problem(UnsupportedMediaTypeException, 'INVALID_UPLOAD');
    }
    const declared = request.headers['content-length'];
    if (declared !== undefined && Number(declared) > this.maxBytes + MULTIPART_OVERHEAD_BYTES) {
      throw problem(PayloadTooLargeException, 'FILE_TOO_LARGE');
    }
    const temporary = this.storage.newTemporaryPath();
    let key: string | null = null;
    try {
      const upload = await this.receive(request, temporary);
      const filename = sanitizeFilename(upload.filename);
      const kind = kindFromFilename(filename);
      if (kind === null) throw problem(UnsupportedMediaTypeException, 'UNSUPPORTED_FORMAT');
      if (upload.size === 0) throw problem(BadRequestException, 'EMPTY_FILE');
      if (!signatureMatches(kind, upload.head)) {
        throw problem(UnsupportedMediaTypeException, 'CONTENT_MISMATCH');
      }
      key = this.storage.newKey();
      await this.storage.commit(temporary, key);
      try {
        const row = await this.prisma.document.create({
          data: {
            userId,
            originalFilename: filename,
            storageKey: key,
            kind,
            mediaType: MEDIA_TYPES[kind],
            sizeBytes: upload.size,
            sha256: upload.sha256,
            job: { create: {} },
          },
          select: VIEW,
        });
        return view(row);
      } catch (error) {
        await this.storage.remove(key); // storage and database stay consistent
        key = null;
        throw error;
      }
    } finally {
      await this.storage.removeTemporary(temporary);
    }
  }

  /** Streams the single `file` part to disk, hashing and counting as it goes (no buffering). */
  private receive(
    request: Request,
    temporary: string,
  ): Promise<{ filename: string; size: number; sha256: string; head: Buffer }> {
    return new Promise((resolve, reject) => {
      let parser: busboy.Busboy;
      try {
        parser = busboy({
          headers: request.headers,
          defParamCharset: 'utf8',
          limits: { files: 1, fileSize: this.maxBytes, fields: 4, fieldSize: 1024, parts: 6 },
        });
      } catch {
        reject(problem(BadRequestException, 'INVALID_UPLOAD'));
        return;
      }
      let received = 0;
      let tooLarge = false;
      const state: {
        finished: Promise<{
          filename: string;
          size: number;
          sha256: string;
          head: Buffer;
        }> | null;
      } = { finished: null };
      const abort = (error: Error): void => {
        request.unpipe(parser);
        reject(error);
      };
      request.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.maxBytes + MULTIPART_OVERHEAD_BYTES) {
          tooLarge = true;
          abort(problem(PayloadTooLargeException, 'FILE_TOO_LARGE'));
          request.resume();
        }
      });
      parser.on('file', (name, stream, info) => {
        if (name !== 'file' || state.finished !== null) {
          stream.resume();
          return;
        }
        const hash = createHash('sha256');
        let size = 0;
        let head = Buffer.alloc(0);
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            size += chunk.length;
            hash.update(chunk);
            if (head.length < SIGNATURE_WINDOW) {
              head = Buffer.concat([head, chunk.subarray(0, SIGNATURE_WINDOW - head.length)]);
            }
            callback(null, chunk);
          },
        });
        stream.on('limit', () => {
          tooLarge = true;
        });
        state.finished = pipeline(
          stream,
          meter,
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        ).then(() => ({
          filename: info.filename ?? 'document',
          size,
          sha256: hash.digest('hex'),
          head,
        }));
        state.finished.catch(() => undefined);
      });
      parser.on('error', () => abort(problem(BadRequestException, 'INVALID_UPLOAD')));
      parser.on('close', () => {
        if (tooLarge) {
          reject(problem(PayloadTooLargeException, 'FILE_TOO_LARGE'));
        } else if (state.finished === null) {
          reject(problem(BadRequestException, 'INVALID_UPLOAD'));
        } else {
          state.finished.then(resolve, () =>
            reject(problem(BadRequestException, 'INVALID_UPLOAD')),
          );
        }
      });
      request.on('aborted', () => reject(problem(BadRequestException, 'INVALID_UPLOAD')));
      request.pipe(parser);
    });
  }

  // -- queries ---------------------------------------------------------------------------------

  async list(
    userId: string,
    query: {
      q: string | undefined;
      status: DocumentStatus | undefined;
      kind: DocumentKind | undefined;
      page: number;
      pageSize: number;
    },
  ): Promise<{ items: DocumentView[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.DocumentWhereInput = {
      userId,
      ...(query.q !== undefined && query.q.trim() !== ''
        ? { originalFilename: { contains: query.q.trim(), mode: 'insensitive' } }
        : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.document.findMany({
        where,
        select: VIEW,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.document.count({ where }),
    ]);
    return { items: rows.map(view), total, page: query.page, pageSize: query.pageSize };
  }

  async get(userId: string, id: string): Promise<DocumentView> {
    const row = await this.prisma.document.findFirst({ where: { id, userId }, select: VIEW });
    if (row === null) throw new NotFoundException();
    return view(row);
  }

  async chunks(
    userId: string,
    id: string,
    page: number,
    pageSize: number,
  ): Promise<{ items: ChunkView[]; total: number; page: number; pageSize: number }> {
    const document = await this.prisma.document.findFirst({
      where: { id, userId },
      select: { activeGeneration: true },
    });
    if (document === null) throw new NotFoundException();
    if (document.activeGeneration === null) return { items: [], total: 0, page, pageSize };
    const where = { documentId: id, generation: document.activeGeneration };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.documentChunk.findMany({
        where,
        orderBy: { chunkIndex: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.documentChunk.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        index: row.chunkIndex,
        content: row.content,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        heading: row.heading,
        section: row.section,
        articles: articlesOf(row.location),
        charStart: row.charStart,
        charEnd: row.charEnd,
        estimatedTokens: row.estimatedTokens,
      })),
      total,
      page,
      pageSize,
    };
  }

  /** Metadata needed to stream the original; null when the user does not own the document. */
  async forDownload(
    userId: string,
    id: string,
  ): Promise<{ filename: string; mediaType: string; storageKey: string }> {
    const row = await this.prisma.document.findFirst({
      where: { id, userId },
      select: { originalFilename: true, mediaType: true, storageKey: true },
    });
    if (row === null) throw new NotFoundException();
    return {
      filename: row.originalFilename,
      mediaType: row.mediaType,
      storageKey: row.storageKey,
    };
  }

  async open(storageKey: string): ReturnType<DocumentStorageService['open']> {
    return this.storage.open(storageKey);
  }

  // -- mutations -------------------------------------------------------------------------------

  /** Re-queue a failed document. The unique job row is reused, so duplicates cannot appear. */
  async retry(userId: string, id: string): Promise<DocumentView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM documents WHERE id = ${id}::uuid AND "userId" = ${userId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException();
      const document = await tx.document.updateMany({
        where: { id, userId, status: 'FAILED' },
        data: { status: 'PENDING', errorCode: null, updatedAt: new Date() },
      });
      if (document.count !== 1) throw new ConflictException(); // only FAILED documents are retryable
      await tx.documentProcessingJob.updateMany({
        where: { documentId: id },
        data: {
          status: 'PENDING',
          attempts: 0,
          errorCode: null,
          leaseToken: null,
          leaseExpiresAt: null,
          runAfter: new Date(),
          startedAt: null,
          finishedAt: null,
          updatedAt: new Date(),
        },
      });
    });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.document.findFirst({
      where: { id, userId },
      select: { storageKey: true },
    });
    if (row === null) throw new NotFoundException();
    // Rows first (chunks and the job cascade), so a stale worker cannot publish into a deleted
    // document; then stop any running work; the file is removed last and, if that fails, swept later.
    const result = await this.prisma.document.deleteMany({ where: { id, userId } });
    if (result.count === 0) throw new NotFoundException();
    this.processor.cancel(id);
    await this.storage.remove(row.storageKey);
    this.logger.log(`Document ${id} deleted`);
  }
}

function articlesOf(location: Prisma.JsonValue): string[] {
  if (typeof location === 'object' && location !== null && !Array.isArray(location)) {
    const articles = location.articles;
    if (Array.isArray(articles)) return articles.filter((a): a is string => typeof a === 'string');
  }
  return [];
}
