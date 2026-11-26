import { createHash } from 'node:crypto';
import { existsSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FakeAiService,
  api,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  uploadDocument,
  uuid,
  type Session,
  type TestApp,
} from './support';
import { DocumentProcessorService } from '../src/documents/document-processor.service';

type Doc = {
  id: string;
  originalFilename: string;
  kind: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  status: string;
  errorCode: string | null;
  extraction: Record<string, unknown> | null;
};

const PDF = (marker = 'OK'): Buffer => Buffer.from(`%PDF-1.4\n[[${marker}]]\n%%EOF\n`);
const DOCX = (marker = 'OK'): Buffer =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`[[${marker}]]`)]);
const TXT = (marker = 'OK'): Buffer => Buffer.from(`Điều 1. Quy định chung [[${marker}]]`);

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Documents: upload, processing lifecycle, privacy (e2e, real PostgreSQL)', () => {
  const ai = new FakeAiService();
  let t: TestApp;
  let alice: Session;
  let bob: Session;
  let admin: Session;
  const processor = (): DocumentProcessorService => t.app.get(DocumentProcessorService);
  const upload = async (filename: string, bytes: Buffer, s: Session = alice): Promise<Doc> => {
    const response = await uploadDocument(t, s, filename, bytes);
    expect(response.status).toBe(201);
    return (await response.json()) as Doc;
  };
  const get = async (id: string, s: Session = alice): Promise<Doc> =>
    (await (await api(t, 'GET', `/documents/${id}`, s)).json()) as Doc;
  const process = async (): Promise<void> => processor().drain();

  beforeAll(async () => {
    await ai.start();
  });
  afterAll(async () => {
    await ai.stop();
  });
  beforeEach(async () => {
    t = await createTestApp(ai, { DOCUMENT_MAX_ATTEMPTS: '2' });
    await resetDatabase(t.prisma);
    ai.docRequests.length = 0;
    ai.docCancelled = 0;
    ai.docMaxActive = 0;
    await createUser(t.prisma, 'alice@example.com');
    await createUser(t.prisma, 'bob@example.com');
    await createUser(t.prisma, 'root@example.com', { role: 'ADMIN' });
    alice = await login(t, 'alice@example.com');
    bob = await login(t, 'bob@example.com');
    admin = await login(t, 'root@example.com');
  });
  afterEach(async () => {
    ai.releaseSlow();
    await t.close();
  });

  it('stores a validated upload privately, processes it and publishes ordered chunks', async () => {
    const bytes = PDF();
    const doc = await upload('Báo cáo quý 3.pdf', bytes);
    expect(doc).toMatchObject({
      originalFilename: 'Báo cáo quý 3.pdf',
      kind: 'PDF',
      mediaType: 'application/pdf',
      status: 'PENDING',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    const stored = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(stored.storageKey).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}$/); // generated, not user-derived
    expect(existsSync(join(t.storageDir, 'files', stored.storageKey))).toBe(true);
    expect(JSON.stringify(doc)).not.toContain(stored.storageKey); // never exposed to the client

    await process();
    const ready = await get(doc.id);
    expect(ready.status).toBe('READY');
    expect(ready.extraction).toMatchObject({ chunkCount: 3, library: 'fake' });
    const page = (await (
      await api(t, 'GET', `/documents/${doc.id}/chunks?pageSize=2`, alice)
    ).json()) as {
      items: { index: number; content: string; pageStart: number; articles: string[] }[];
      total: number;
    };
    expect(page.total).toBe(3);
    expect(page.items.map((c) => c.index)).toEqual([0, 1]);
    expect(page.items[0]).toMatchObject({ pageStart: 1, articles: ['Điều 1'] });
    expect(page.items[0]?.content).toContain('Nội dung đoạn 1');
    const second = (await (
      await api(t, 'GET', `/documents/${doc.id}/chunks?page=2&pageSize=2`, alice)
    ).json()) as {
      items: { index: number }[];
    };
    expect(second.items.map((c) => c.index)).toEqual([2]);
    expect(ai.docRequests).toEqual([{ kind: 'pdf', size: bytes.length, marker: 'OK' }]);
  });

  it('accepts DOCX and TXT, detects the kind from content-checked extensions', async () => {
    const docx = await upload('hop-dong.DOCX', DOCX());
    const txt = await upload('ghi-chu.txt', TXT());
    expect([docx.kind, txt.kind]).toEqual(['DOCX', 'TXT']);
    expect(docx.mediaType).toContain('wordprocessingml');
    await process();
    expect((await get(docx.id)).status).toBe('READY');
    expect((await get(txt.id)).status).toBe('READY');
    expect(ai.docRequests.map((r) => r.kind).sort()).toEqual(['docx', 'txt']);
  });

  it('rejects invalid uploads and leaves no files or rows behind', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('rest')]);
    expect(await code(await uploadDocument(t, alice, 'run.exe', Buffer.from('MZ')))).toEqual([
      415,
      'UNSUPPORTED_FORMAT',
    ]);
    expect(await code(await uploadDocument(t, alice, 'fake.pdf', png))).toEqual([
      415,
      'CONTENT_MISMATCH',
    ]);
    expect(
      await code(await uploadDocument(t, alice, 'fake.docx', Buffer.from('%PDF-1.4'))),
    ).toEqual([415, 'CONTENT_MISMATCH']);
    expect(await code(await uploadDocument(t, alice, 'bin.txt', Buffer.from([65, 0, 66])))).toEqual(
      [415, 'CONTENT_MISMATCH'],
    );
    expect(await code(await uploadDocument(t, alice, 'empty.pdf', Buffer.alloc(0)))).toEqual([
      400,
      'EMPTY_FILE',
    ]);
    expect(await code(await uploadDocument(t, alice, 'noext', Buffer.from('x')))).toEqual([
      415,
      'UNSUPPORTED_FORMAT',
    ]);
    const notMultipart = await fetch(`${t.url}/api/v1/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: alice.cookie,
        'X-CSRF-Token': alice.csrf,
      },
      body: '{}',
    });
    expect(await code(notMultipart)).toEqual([415, 'INVALID_UPLOAD']);
    const noFilePart = new FormData();
    noFilePart.append('note', 'no file here');
    const missing = await fetch(`${t.url}/api/v1/documents`, {
      method: 'POST',
      headers: { Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf },
      body: noFilePart,
    });
    expect(await code(missing)).toEqual([400, 'INVALID_UPLOAD']);
    expect(await t.prisma.document.count()).toBe(0);
    expect(readdirSync(join(t.storageDir, 'files'))).toEqual([]);
    expect(readdirSync(join(t.storageDir, 'tmp'))).toEqual([]);
  });

  it('enforces the size limit while streaming and cleans up the partial file', async () => {
    await t.close();
    t = await createTestApp(ai, { DOCUMENT_MAX_BYTES: '4096' });
    await resetDatabase(t.prisma);
    await createUser(t.prisma, 'alice@example.com');
    alice = await login(t, 'alice@example.com');
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20_000, 0x41)]);
    expect(await code(await uploadDocument(t, alice, 'big.pdf', big))).toEqual([
      413,
      'FILE_TOO_LARGE',
    ]);
    const justUnder = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4000, 0x41)]);
    expect((await uploadDocument(t, alice, 'ok.pdf', justUnder)).status).toBe(201);
    expect(await t.prisma.document.count()).toBe(1);
    expect(readdirSync(join(t.storageDir, 'tmp'))).toEqual([]);
  });

  it('neutralizes path traversal filenames and never writes outside the storage root', async () => {
    const names = [
      '../../evil.txt',
      '..\\..\\windows\\evil.txt',
      'C:\\temp\\evil.txt',
      '/etc/passwd.txt',
      'ev<i>l|?.txt',
    ];
    for (const name of names) {
      const doc = await upload(name, TXT());
      expect(doc.originalFilename).not.toMatch(/[\\/<>|?:]/);
      expect(doc.originalFilename.endsWith('.txt')).toBe(true);
    }
    const files = (await t.prisma.document.findMany()).map((d) => d.storageKey);
    expect(new Set(files).size).toBe(names.length);
    expect(files.every((key) => /^[0-9a-f]{2}\/[0-9a-f-]{36}$/.test(key))).toBe(true);
    expect(existsSync(join(t.storageDir, '..', 'evil.txt'))).toBe(false);
  });

  it('requires authentication and a CSRF token for every document operation', async () => {
    expect((await uploadDocument(t, null, 'a.txt', TXT())).status).toBe(401);
    const noCsrf = await uploadDocument(t, { ...alice, csrf: '' }, 'a.txt', TXT());
    expect(noCsrf.status).toBe(403);
    const doc = await upload('a.txt', TXT());
    for (const [method, path] of [
      ['GET', '/documents'],
      ['GET', `/documents/${doc.id}`],
      ['GET', `/documents/${doc.id}/chunks`],
      ['GET', `/documents/${doc.id}/download`],
      ['POST', `/documents/${doc.id}/retry`],
      ['DELETE', `/documents/${doc.id}`],
    ] as const) {
      expect([path, (await api(t, method, path, null)).status]).toEqual([path, 401]);
    }
    expect((await api(t, 'DELETE', `/documents/${doc.id}`, { ...alice, csrf: '' })).status).toBe(
      403,
    );
    expect(
      (await api(t, 'POST', `/documents/${doc.id}/retry`, { ...alice, csrf: '' })).status,
    ).toBe(403);
    expect(await t.prisma.document.count()).toBe(1);
  });

  it('isolates documents between users and from administrators', async () => {
    const doc = await upload('secret.pdf', PDF());
    await process();
    const attempts: [string, string][] = [
      ['GET', `/documents/${doc.id}`],
      ['GET', `/documents/${doc.id}/chunks`],
      ['GET', `/documents/${doc.id}/download`],
      ['POST', `/documents/${doc.id}/retry`],
      ['DELETE', `/documents/${doc.id}`],
    ];
    for (const actor of [bob, admin]) {
      for (const [method, path] of attempts) {
        expect([method, path, (await api(t, method, path, actor)).status]).toEqual([
          method,
          path,
          404,
        ]);
      }
      const list = (await (await api(t, 'GET', '/documents', actor)).json()) as { total: number };
      expect(list.total).toBe(0);
    }
    expect((await get(doc.id)).status).toBe('READY');
    expect(await t.prisma.documentChunk.count()).toBe(3);
  });

  it('downloads the original as a safe attachment, byte for byte', async () => {
    const bytes = PDF();
    const doc = await upload('Hợp đồng "mẫu".pdf', bytes);
    const response = await api(t, 'GET', `/documents/${doc.id}/download`, alice);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).toContain("filename*=UTF-8''H%E1%BB%A3p");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    // A file missing on disk is a plain 404; the document record stays and no path leaks.
    const stored = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    const { rmSync } = await import('node:fs');
    rmSync(join(t.storageDir, 'files', stored.storageKey));
    const missing = await api(t, 'GET', `/documents/${doc.id}/download`, alice);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(t.storageDir);
    expect((await get(doc.id)).id).toBe(doc.id);
  });

  it('lists with pagination, filename search, status and type filters', async () => {
    await upload('Báo cáo tài chính.pdf', PDF());
    await upload('Báo cáo nhân sự.docx', DOCX());
    await upload('ghi chú.txt', TXT('OCR'));
    await process();
    const list = async (qs: string): Promise<{ items: Doc[]; total: number }> =>
      (await (await api(t, 'GET', `/documents${qs}`, alice)).json()) as {
        items: Doc[];
        total: number;
      };
    expect((await list('')).total).toBe(3);
    expect((await list('?q=B%C3%81O%20C%C3%81O')).total).toBe(2);
    expect((await list('?kind=PDF')).items.map((d) => d.kind)).toEqual(['PDF']);
    expect((await list('?status=OCR_REQUIRED')).items.map((d) => d.originalFilename)).toEqual([
      'ghi chú.txt',
    ]);
    const page = await list('?page=2&pageSize=2');
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    for (const bad of ['?pageSize=500', '?status=NOPE', '?kind=EXE', '?page=0']) {
      expect([bad, (await api(t, 'GET', `/documents${bad}`, alice)).status]).toEqual([bad, 400]);
    }
  });

  it('reports OCR_REQUIRED, PARTIAL and permanent failures explicitly', async () => {
    const ocr = await upload('scan.pdf', PDF('OCR'));
    const partial = await upload('mixed.pdf', PDF('PARTIAL'));
    const bad = await upload('bad.pdf', PDF('MALFORMED'));
    await process();
    expect(await get(ocr.id)).toMatchObject({ status: 'OCR_REQUIRED', errorCode: 'OCR_REQUIRED' });
    expect(await (await api(t, 'GET', `/documents/${ocr.id}/chunks`, alice)).json()).toMatchObject({
      total: 0,
    });
    const p = await get(partial.id);
    expect(p.status).toBe('PARTIAL');
    expect(p.extraction).toMatchObject({ coverage: 0.5 });
    expect(await get(bad.id)).toMatchObject({ status: 'FAILED', errorCode: 'MALFORMED_DOCUMENT' });
    expect(await t.prisma.documentChunk.count({ where: { documentId: bad.id } })).toBe(0);
  });

  it('retries only failed documents, once, without duplicating jobs or chunks', async () => {
    const doc = await upload('flaky.pdf', PDF('FLAKY'));
    await process(); // first attempt: processor unavailable -> backoff, not failed yet
    let job = await t.prisma.documentProcessingJob.findUniqueOrThrow({
      where: { documentId: doc.id },
    });
    expect([job.status, job.attempts]).toEqual(['PENDING', 1]);
    expect((await get(doc.id)).status).toBe('PENDING');
    await t.prisma.documentProcessingJob.update({
      where: { id: job.id },
      data: { runAfter: new Date() },
    });
    await process(); // second attempt succeeds (the fake only fails once per document)
    expect((await get(doc.id)).status).toBe('READY');
    expect((await api(t, 'POST', `/documents/${doc.id}/retry`, alice)).status).toBe(409);

    const bad = await upload('bad.pdf', PDF('MALFORMED'));
    await process();
    expect((await get(bad.id)).status).toBe('FAILED');
    const [first, second] = await Promise.all([
      api(t, 'POST', `/documents/${bad.id}/retry`, alice),
      api(t, 'POST', `/documents/${bad.id}/retry`, alice),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await t.prisma.documentProcessingJob.count({ where: { documentId: bad.id } })).toBe(1);
    job = await t.prisma.documentProcessingJob.findUniqueOrThrow({ where: { documentId: bad.id } });
    expect([job.status, job.attempts]).toEqual(['PENDING', 0]);
    await process();
    expect(await t.prisma.documentChunk.count({ where: { documentId: bad.id } })).toBe(0);
    expect((await get(bad.id)).status).toBe('FAILED');
  });

  it('fails after the bounded number of transient attempts', async () => {
    const doc = await upload('down.pdf', PDF('503'));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await process();
      await t.prisma.documentProcessingJob.updateMany({ data: { runAfter: new Date() } });
    }
    await process();
    expect(await get(doc.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROCESSOR_UNAVAILABLE',
    });
    expect(ai.docRequests.length).toBe(2); // MAX_ATTEMPTS = 2, no retry storm
  });

  it('treats a stream that ends without a result as transient and discards staged chunks', async () => {
    const doc = await upload('drop.pdf', PDF('DROP'));
    await process();
    expect((await get(doc.id)).status).toBe('PENDING');
    expect(await t.prisma.documentChunk.count({ where: { documentId: doc.id } })).toBe(0);
  });

  it('never runs more than the configured number of jobs at once', async () => {
    await t.close();
    t = await createTestApp(ai, { DOCUMENT_MAX_CONCURRENCY: '1' });
    await resetDatabase(t.prisma);
    await createUser(t.prisma, 'alice@example.com');
    alice = await login(t, 'alice@example.com');
    for (const n of [1, 2, 3]) {
      await upload(
        `slow${n}.pdf`,
        Buffer.from(`%PDF-1.4
[[SLOW]] ${n}`),
      );
    }
    const running = processor().drain();
    await waitFor(() => ai.docRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ai.docRequests.length).toBe(1); // the other two wait for the single slot
    for (let i = 0; i < 3; i += 1) {
      ai.releaseSlow();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await running;
    expect(ai.docMaxActive).toBe(1);
    expect(await t.prisma.document.count({ where: { status: 'READY' } })).toBe(3);
  });

  it('claims a job exactly once across competing workers', async () => {
    const other = await createTestApp(ai, { DOCUMENT_STORAGE_DIR: t.storageDir });
    try {
      await upload('once.pdf', PDF());
      await Promise.all([processor().tick(), other.app.get(DocumentProcessorService).tick()]);
      await Promise.all([processor().drain(), other.app.get(DocumentProcessorService).drain()]);
      expect(ai.docRequests.length).toBe(1);
      expect((await t.prisma.document.findFirstOrThrow()).status).toBe('READY');
    } finally {
      await other.close();
    }
  });

  it('recovers a crashed worker and stops a stale worker from overwriting newer results', async () => {
    const doc = await upload('crash.pdf', Buffer.from('%PDF-1.4\n[[SLOWFIRST]]'));
    const stale = processor().tick(); // worker A claims the job and hangs inside the processor call
    await waitFor(() => ai.docRequests.length === 1);
    const claimedBy = (
      await t.prisma.documentProcessingJob.findUniqueOrThrow({ where: { documentId: doc.id } })
    ).leaseToken;
    expect(claimedBy).not.toBeNull();
    // Worker A "dies": its lease expires while the upstream call is still open.
    await t.prisma.documentProcessingJob.update({
      where: { documentId: doc.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    const other = await createTestApp(ai, { DOCUMENT_STORAGE_DIR: t.storageDir });
    try {
      await other.app.get(DocumentProcessorService).drain(); // worker B reclaims and completes
      const done = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(done.status).toBe('READY');
      const winner = done.activeGeneration;
      expect(winner).not.toBe(claimedBy);
      ai.releaseSlow(); // A's stale response now completes: it must not publish
      await stale;
      await waitFor(() => processor()['active'].size === 0);
      const after = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(after.activeGeneration).toBe(winner);
      expect(await t.prisma.documentChunk.count({ where: { documentId: doc.id } })).toBe(3);
      expect(
        await t.prisma.documentChunk.count({
          where: { documentId: doc.id, generation: claimedBy! },
        }),
      ).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('marks an abandoned job (lease expired on its last attempt) as failed', async () => {
    const doc = await upload('abandoned.pdf', PDF());
    await t.prisma.documentProcessingJob.update({
      where: { documentId: doc.id },
      data: {
        status: 'PROCESSING',
        attempts: 2,
        leaseToken: uuid(),
        leaseExpiresAt: new Date(Date.now() - 5000),
      },
    });
    await processor().tick();
    expect(await get(doc.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'PROCESSING_ABANDONED',
    });
    expect(ai.docRequests.length).toBe(0);
  });

  it('deleting during processing cancels the work and nothing is resurrected', async () => {
    const doc = await upload('doomed.pdf', Buffer.from('%PDF-1.4\n[[SLOW]]'));
    const running = processor().tick();
    await waitFor(() => ai.docRequests.length === 1);
    const stored = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect((await api(t, 'DELETE', `/documents/${doc.id}`, alice)).status).toBe(204);
    await waitFor(() => ai.docCancelled === 1);
    ai.releaseSlow();
    await running;
    await waitFor(() => processor()['active'].size === 0);
    expect(await t.prisma.document.count()).toBe(0);
    expect(await t.prisma.documentChunk.count()).toBe(0);
    expect(await t.prisma.documentProcessingJob.count()).toBe(0);
    expect(existsSync(join(t.storageDir, 'files', stored.storageKey))).toBe(false);
    expect((await api(t, 'GET', `/documents/${doc.id}`, alice)).status).toBe(404);
  });

  it('deleting removes the file, chunks and job, and is idempotent for the owner only', async () => {
    const doc = await upload('gone.pdf', PDF());
    await process();
    const stored = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect((await api(t, 'DELETE', `/documents/${doc.id}`, bob)).status).toBe(404);
    expect((await api(t, 'DELETE', `/documents/${doc.id}`, alice)).status).toBe(204);
    expect((await api(t, 'DELETE', `/documents/${doc.id}`, alice)).status).toBe(404);
    expect(existsSync(join(t.storageDir, 'files', stored.storageKey))).toBe(false);
    expect(await t.prisma.documentChunk.count()).toBe(0);
    expect(await t.prisma.documentProcessingJob.count()).toBe(0);
  });

  it('keeps documents and chunks across an application restart and runs the polling worker', async () => {
    const doc = await upload('persist.pdf', PDF());
    await process();
    await t.close();
    t = await createTestApp(ai, {
      DOCUMENT_WORKER_ENABLED: 'true',
      DOCUMENT_POLL_INTERVAL_MS: '50',
    });
    alice = await login(t, 'alice@example.com');
    expect((await get(doc.id)).status).toBe('READY');
    const chunks = (await (await api(t, 'GET', `/documents/${doc.id}/chunks`, alice)).json()) as {
      total: number;
    };
    expect(chunks.total).toBe(3);
    const fresh = await upload('polled.txt', TXT());
    await waitFor(async () => (await get(fresh.id)).status === 'READY'); // no manual drain
  });

  it('sweeps orphaned files, stale staging chunks and abandoned temporary files', async () => {
    const doc = await upload('keep.pdf', PDF());
    await process();
    const orphanKey = `ab/${uuid()}`;
    mkdirSync(join(t.storageDir, 'files', 'ab'), { recursive: true });
    const orphan = join(t.storageDir, 'files', orphanKey);
    writeFileSync(orphan, 'orphan');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(orphan, old, old);
    const fresh = join(t.storageDir, 'files', 'ab', uuid());
    writeFileSync(fresh, 'recent upload still being committed');
    await t.prisma.documentChunk.create({
      data: {
        documentId: doc.id,
        generation: uuid(),
        chunkIndex: 0,
        content: 'stale',
        charStart: 0,
        charEnd: 5,
        estimatedTokens: 1,
        processingVersion: '1',
      },
    });
    const result = await processor().sweepOrphans();
    expect(result.files).toBe(1);
    expect(result.chunks).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // within the grace period
    expect(await t.prisma.documentChunk.count({ where: { documentId: doc.id } })).toBe(3);
    const stored = await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(existsSync(join(t.storageDir, 'files', stored.storageKey))).toBe(true);
  });

  it('enforces document invariants in the database itself', async () => {
    const doc = await upload('db.pdf', PDF());
    await process();
    const active = (await t.prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
      .activeGeneration!;
    const row = {
      documentId: doc.id,
      generation: active,
      chunkIndex: 0,
      content: 'x',
      charStart: 0,
      charEnd: 1,
      estimatedTokens: 1,
      processingVersion: '1',
    };
    await expect(t.prisma.documentChunk.create({ data: row })).rejects.toThrow(); // duplicate chunk
    await expect(
      t.prisma.documentChunk.create({
        data: { ...row, generation: uuid(), charStart: 5, charEnd: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.documentChunk.create({
        data: { ...row, generation: uuid(), pageStart: 3, pageEnd: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.documentProcessingJob.create({ data: { documentId: doc.id } }),
    ).rejects.toThrow(); // second job
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE documents SET sha256 = 'zz' WHERE id = '${doc.id}'`),
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE document_processing_jobs SET status = 'PROCESSING', "leaseToken" = NULL WHERE "documentId" = '${doc.id}'`,
      ),
    ).rejects.toThrow();
  });
});

async function code(response: Response): Promise<[number, string | undefined]> {
  const body = (await response.json()) as { code?: string };
  return [response.status, body.code];
}
