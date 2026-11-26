import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';
import {
  DocumentProcessingClient,
  ProcessingAbortedError,
  ProcessorUnavailableError,
  type ChunkRecord,
  type SummaryRecord,
} from './document-processing.client';
import { DocumentStorageService } from './document-storage.service';

type ClaimedJob = { id: string; documentId: string; attempts: number; leaseToken: string };

const CHUNK_BATCH_SIZE = 100;
const MAINTENANCE_INTERVAL_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 600_000;
const PROCESSING_VERSION = '1';
const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_MAX_SECONDS = 60;

class LostClaimError extends Error {}

/**
 * Database-backed document processing (no external queue). One row per document in
 * `document_processing_jobs` is claimed atomically (FOR UPDATE SKIP LOCKED) with a renewable lease;
 * a crashed worker's lease expires and the job is claimed again. Results are staged under a fresh
 * generation and published in a single transaction guarded by the lease token, so a stale worker can
 * never overwrite newer results or resurrect a deleted document. No transaction spans extraction.
 */
@Injectable()
export class DocumentProcessorService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DocumentProcessorService.name);
  private readonly active = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastMaintenance = 0;
  private lastOrphanSweep = 0;
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private readonly timeoutSeconds: number;
  private readonly maxAttempts: number;
  private readonly pollMs: number;
  private readonly enabled: boolean;
  private readonly orphanGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: DocumentStorageService,
    private readonly client: DocumentProcessingClient,
    config: ConfigService<Environment, true>,
  ) {
    this.concurrency = config.get('DOCUMENT_MAX_CONCURRENCY', { infer: true });
    this.leaseSeconds = config.get('DOCUMENT_JOB_LEASE_SECONDS', { infer: true });
    this.timeoutSeconds = config.get('DOCUMENT_JOB_TIMEOUT_SECONDS', { infer: true });
    this.maxAttempts = config.get('DOCUMENT_MAX_ATTEMPTS', { infer: true });
    this.pollMs = config.get('DOCUMENT_POLL_INTERVAL_MS', { infer: true });
    this.enabled = config.get('DOCUMENT_WORKER_ENABLED', { infer: true });
    this.orphanGraceMs = config.get('DOCUMENT_ORPHAN_GRACE_SECONDS', { infer: true }) * 1000;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort('cancelled');
  }

  /** Stop any in-flight processing of a document that is being deleted. */
  cancel(documentId: string): void {
    this.active.get(documentId)?.abort('cancelled');
  }

  /** Test and operations helper: process until nothing is claimable and nothing is running. */
  async drain(): Promise<void> {
    for (let round = 0; round < 1000; round += 1) {
      await this.tick();
      while (this.active.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      const waiting = await this.prisma.documentProcessingJob.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] }, runAfter: { lte: new Date() } },
      });
      if (waiting === 0) return;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.maintain();
      while (this.active.size < this.concurrency) {
        const job = await this.claim();
        if (job === null) break;
        const run = this.process(job).catch(() => {
          this.logger.error(`Unexpected processing failure for job ${job.id}`);
        });
        void run;
        // Let the claimed job register itself before we look at the concurrency bound again.
        await new Promise((resolve) => setImmediate(resolve));
      }
    } catch {
      this.logger.warn('Document processor tick failed');
    } finally {
      this.ticking = false;
    }
  }

  // -- claiming and maintenance -----------------------------------------------------------------

  private async claim(): Promise<ClaimedJob | null> {
    const token = randomUUID();
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE document_processing_jobs AS j
      SET status = 'PROCESSING',
          "leaseToken" = ${token}::uuid,
          "leaseExpiresAt" = now() + make_interval(secs => ${this.leaseSeconds}::double precision),
          attempts = j.attempts + 1,
          "startedAt" = now(),
          "errorCode" = NULL,
          "updatedAt" = now()
      WHERE j.id = (
        SELECT id FROM document_processing_jobs
        WHERE (status = 'PENDING' AND "runAfter" <= now())
           OR (status = 'PROCESSING' AND "leaseExpiresAt" < now() AND attempts < ${this.maxAttempts})
        ORDER BY "runAfter", "createdAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.id, j."documentId", j.attempts, j."leaseToken"::text AS "leaseToken"`;
    return rows[0] ?? null;
  }

  private async maintain(): Promise<void> {
    const now = Date.now();
    if (now - this.lastMaintenance >= MAINTENANCE_INTERVAL_MS) {
      this.lastMaintenance = now;
      // A job whose lease expired after its last attempt is abandoned, not retried forever.
      const abandoned = await this.prisma.$queryRaw<{ documentId: string }[]>`
        UPDATE document_processing_jobs
        SET status = 'FAILED', "errorCode" = 'PROCESSING_ABANDONED', "leaseToken" = NULL,
            "leaseExpiresAt" = NULL, "finishedAt" = now(), "updatedAt" = now()
        WHERE status = 'PROCESSING' AND "leaseExpiresAt" < now() AND attempts >= ${this.maxAttempts}
        RETURNING "documentId"`;
      if (abandoned.length > 0) {
        await this.prisma.document.updateMany({
          where: {
            id: { in: abandoned.map((row) => row.documentId) },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
          data: { status: 'FAILED', errorCode: 'PROCESSING_ABANDONED', updatedAt: new Date() },
        });
      }
    }
    if (now - this.lastOrphanSweep >= ORPHAN_SWEEP_INTERVAL_MS) {
      this.lastOrphanSweep = now;
      await this.sweepOrphans();
    }
  }

  /** Remove stored files without a document row and staging chunks of abandoned generations. */
  async sweepOrphans(): Promise<{ files: number; chunks: number }> {
    const rows = await this.prisma.document.findMany({ select: { storageKey: true } });
    const files = await this.storage.sweepOrphans(
      new Set(rows.map((row) => row.storageKey)),
      this.orphanGraceMs,
    );
    const chunks = await this.prisma.$executeRaw`
      DELETE FROM document_chunks c
      USING documents d
      WHERE c."documentId" = d.id
        AND c.generation IS DISTINCT FROM d."activeGeneration"
        AND NOT EXISTS (
          SELECT 1 FROM document_processing_jobs j
          WHERE j."documentId" = d.id AND j.status = 'PROCESSING' AND j."leaseToken" = c.generation
        )`;
    return { files, chunks };
  }

  // -- one job -------------------------------------------------------------------------------

  private async process(job: ClaimedJob): Promise<void> {
    const controller = new AbortController();
    this.active.set(job.documentId, controller);
    const deadline = setTimeout(() => controller.abort('timeout'), this.timeoutSeconds * 1000);
    deadline.unref();
    const heartbeat = setInterval(
      () => void this.renewLease(job, controller),
      Math.max(1000, (this.leaseSeconds * 1000) / 3),
    );
    heartbeat.unref();
    try {
      await this.run(job, controller.signal);
    } catch (error) {
      await this.handleFailure(job, error);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.active.delete(job.documentId);
    }
  }

  private async run(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    const document = await this.prisma.document.findUnique({
      where: { id: job.documentId },
      select: { id: true, kind: true, storageKey: true, activeGeneration: true },
    });
    if (document === null) return; // deleted after the claim: nothing to do and nothing to resurrect
    await this.prisma.document.updateMany({
      where: { id: document.id, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PROCESSING', errorCode: null, updatedAt: new Date() },
    });
    // Staging left behind by a crashed earlier attempt is never reused: start from a clean slate.
    await this.prisma.documentChunk.deleteMany({
      where: {
        documentId: document.id,
        generation: { not: job.leaseToken },
        ...(document.activeGeneration !== null
          ? { NOT: { generation: document.activeGeneration } }
          : {}),
      },
    });
    const file = await this.storage.locate(document.storageKey);
    if (file === null) throw new PermanentFailure('FILE_MISSING');

    let batch: ChunkRecord[] = [];
    let staged = 0;
    let summary: SummaryRecord | null = null;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const rows = batch;
      batch = [];
      try {
        await this.prisma.documentChunk.createMany({
          data: rows.map((chunk) => ({
            documentId: document.id,
            generation: job.leaseToken,
            chunkIndex: chunk.index,
            content: chunk.content,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            heading: chunk.heading,
            section: chunk.section,
            location: { articles: chunk.articles },
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            estimatedTokens: chunk.estimatedTokens,
            processingVersion: PROCESSING_VERSION,
          })),
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
          throw new ProcessingAbortedError('cancelled'); // the document was deleted meanwhile
        }
        throw error;
      }
      staged += rows.length;
    };

    for await (const record of this.client.process(file.path, file.size, document.kind, {
      requestId: job.id,
      signal,
    })) {
      if (record.type === 'chunk') {
        batch.push(record);
        if (batch.length >= CHUNK_BATCH_SIZE) await flush();
      } else if (record.type === 'error') {
        throw new PermanentFailure(record.code);
      } else {
        summary = record;
      }
    }
    await flush();
    if (summary === null) throw new ProcessorUnavailableError('processing ended without a result');
    const expected = Number(summary.metadata.chunkCount ?? 0);
    if (expected !== staged) throw new ProcessorUnavailableError('chunk count mismatch');
    await this.publish(job, document.id, summary, staged);
  }

  /** The only place results become visible: one transaction, guarded by the lease token. */
  private async publish(
    job: ClaimedJob,
    documentId: string,
    summary: SummaryRecord,
    chunkCount: number,
  ): Promise<void> {
    const failed = summary.status === 'FAILED';
    try {
      await this.prisma.$transaction(async (tx) => {
        const owned = await tx.documentProcessingJob.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
          data: {
            status: failed ? 'FAILED' : 'SUCCEEDED',
            errorCode: summary.code,
            leaseToken: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        if (owned.count !== 1) throw new LostClaimError();
        const updated = await tx.document.updateMany({
          where: { id: documentId },
          data: {
            status: summary.status,
            errorCode: summary.code,
            extractionMetadata: summary.metadata as Prisma.InputJsonValue,
            activeGeneration: chunkCount > 0 && !failed ? job.leaseToken : null,
            updatedAt: new Date(),
          },
        });
        if (updated.count !== 1) throw new LostClaimError();
        await tx.documentChunk.deleteMany({
          where: {
            documentId,
            ...(chunkCount > 0 && !failed ? { generation: { not: job.leaseToken } } : {}),
          },
        });
      });
    } catch (error) {
      if (error instanceof LostClaimError) {
        // Newer work owns the job, or the document is gone: discard only what this attempt staged.
        await this.discardStaging(documentId, job.leaseToken);
        return;
      }
      throw error;
    }
  }

  private async renewLease(job: ClaimedJob, controller: AbortController): Promise<void> {
    try {
      const renewed = await this.prisma.$executeRaw`
        UPDATE document_processing_jobs
        SET "leaseExpiresAt" = now() + make_interval(secs => ${this.leaseSeconds}::double precision),
            "updatedAt" = now()
        WHERE id = ${job.id}::uuid AND "leaseToken" = ${job.leaseToken}::uuid AND status = 'PROCESSING'`;
      if (renewed === 0) controller.abort('cancelled'); // lost the claim: stop spending resources
    } catch {
      this.logger.warn('Could not renew a job lease');
    }
  }

  // -- failure handling ----------------------------------------------------------------------

  private async handleFailure(job: ClaimedJob, error: unknown): Promise<void> {
    if (error instanceof ProcessingAbortedError) {
      if (error.reason === 'timeout') await this.fail(job, 'PROCESSING_TIMEOUT');
      else await this.discardStaging(job.documentId, job.leaseToken);
      return;
    }
    if (error instanceof PermanentFailure) {
      await this.fail(job, error.code);
      return;
    }
    // Everything else (processor busy or down, connection reset, database hiccup) is transient.
    await this.requeueOrFail(job, 'PROCESSOR_UNAVAILABLE');
  }

  private async fail(job: ClaimedJob, code: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const owned = await tx.documentProcessingJob.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
          data: {
            status: 'FAILED',
            errorCode: code,
            leaseToken: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        if (owned.count !== 1) throw new LostClaimError();
        await tx.document.updateMany({
          where: { id: job.documentId, status: { in: ['PENDING', 'PROCESSING'] } },
          data: { status: 'FAILED', errorCode: code, updatedAt: new Date() },
        });
      });
    } catch (error) {
      if (!(error instanceof LostClaimError)) throw error;
    }
    await this.discardStaging(job.documentId, job.leaseToken);
  }

  private async requeueOrFail(job: ClaimedJob, code: string): Promise<void> {
    if (job.attempts >= this.maxAttempts) {
      await this.fail(job, code);
      return;
    }
    const delaySeconds = Math.min(
      BACKOFF_MAX_SECONDS,
      BACKOFF_BASE_SECONDS * 2 ** (job.attempts - 1),
    );
    const requeued = await this.prisma.documentProcessingJob.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken, status: 'PROCESSING' },
      data: {
        status: 'PENDING',
        leaseToken: null,
        leaseExpiresAt: null,
        runAfter: new Date(Date.now() + delaySeconds * 1000),
        updatedAt: new Date(),
      },
    });
    if (requeued.count === 1) {
      await this.prisma.document.updateMany({
        where: { id: job.documentId, status: 'PROCESSING' },
        data: { status: 'PENDING', updatedAt: new Date() },
      });
    }
    await this.discardStaging(job.documentId, job.leaseToken);
  }

  private async discardStaging(documentId: string, generation: string): Promise<void> {
    await this.prisma.documentChunk
      .deleteMany({ where: { documentId, generation } })
      .catch(() => undefined);
  }
}

/** A content-related failure that retrying cannot fix (encrypted, malformed, limits, OCR needed...). */
export class PermanentFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
