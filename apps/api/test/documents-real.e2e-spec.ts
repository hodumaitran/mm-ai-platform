import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DocumentProcessorService } from '../src/documents/document-processor.service';
import {
  FakeAiService,
  api,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  uploadDocument,
  type Session,
  type TestApp,
} from './support';

const ROOT = resolve(__dirname, '..', '..', '..');
const AI_DIR = join(ROOT, 'apps', 'ai-service');
const PYTHON = [
  join(ROOT, '.venv', 'Scripts', 'python.exe'),
  join(ROOT, '.venv', 'bin', 'python'),
].find((candidate) => existsSync(candidate));

type Doc = {
  id: string;
  status: string;
  errorCode: string | null;
  extraction: Record<string, unknown>;
};
type Chunk = {
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  articles: string[];
  charStart: number;
  charEnd: number;
};

async function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePort(port));
    });
  });
}

// The real Python service is only available where the repository virtual environment exists (not in
// the JavaScript-only CI job). When it is missing the suite is reported as skipped, never as passed.
const suite = PYTHON === undefined ? describe.skip : describe;

suite('Documents through the REAL Python extraction service (e2e, real PostgreSQL)', () => {
  const ai = new FakeAiService();
  let python: ChildProcess;
  let t: TestApp;
  let alice: Session;
  const fixtures = mkdtempSync(join(tmpdir(), 'mm-ai-fixtures-'));

  beforeAll(async () => {
    const made = spawnSync(PYTHON as string, ['-m', 'tests.make_fixtures', fixtures], {
      cwd: AI_DIR,
      encoding: 'utf8',
    });
    if (made.status !== 0) throw new Error(`fixture generation failed: ${made.stderr}`);
    const port = await freePort();
    python = spawn(
      PYTHON as string,
      [
        '-m',
        'uvicorn',
        'mm_ai_service.main:create_app',
        '--factory',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      { cwd: AI_DIR, env: { ...process.env, AI_SERVICE_ENV: 'test' }, stdio: 'ignore' },
    );
    await ai.start();
    const url = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    t = await createTestApp(ai, { AI_SERVICE_BASE_URL: url });
    await resetDatabase(t.prisma);
    await createUser(t.prisma, 'alice@example.com');
    alice = await login(t, 'alice@example.com');
  }, 60000);

  afterAll(async () => {
    await t?.close();
    await ai.stop();
    python?.kill();
  });

  const send = async (name: string): Promise<Doc> => {
    const response = await uploadDocument(t, alice, name, readFileSync(join(fixtures, name)));
    expect(response.status).toBe(201);
    const doc = (await response.json()) as Doc;
    await t.app.get(DocumentProcessorService).drain();
    return (await (await api(t, 'GET', `/documents/${doc.id}`, alice)).json()) as Doc;
  };
  const chunks = async (id: string): Promise<Chunk[]> =>
    (
      (await (await api(t, 'GET', `/documents/${id}/chunks?pageSize=50`, alice)).json()) as {
        items: Chunk[];
      }
    ).items;

  it('extracts a Vietnamese PDF with real page numbers and legal structure', async () => {
    const doc = await send('legal.pdf');
    expect(doc.status).toBe('READY');
    expect(doc.extraction).toMatchObject({
      pagesTotal: 3,
      pagesExtracted: 3,
      coverage: 1,
    });
    expect(String(doc.extraction.library)).toContain('pypdf');
    const parts = await chunks(doc.id);
    const text = parts.map((c) => c.content).join('\n');
    expect(text).toContain('Mức phạt tối đa là 1.500.000 đồng, áp dụng từ ngày 01/07/2026.');
    expect(text).toContain('Điều 3. Trách nhiệm của đơn vị');
    expect(parts[0]?.pageStart).toBe(1);
    expect(parts.at(-1)?.pageEnd).toBe(3);
    expect(parts.some((c) => c.articles.includes('Điều 2'))).toBe(true);
    expect(parts.some((c) => c.articles.includes('Điều 3'))).toBe(true);
  });

  it('is deterministic: the same file yields identical chunks and offsets', async () => {
    const [first, second] = [await send('legal.pdf'), await send('legal.pdf')];
    expect(await chunks(first.id)).toEqual(await chunks(second.id));
  });

  it('extracts DOCX (headings, paragraphs, tables, no invented pages) and TXT', async () => {
    const docx = await send('legal.docx');
    expect(docx.status).toBe('READY');
    const parts = await chunks(docx.id);
    const text = parts.map((c) => c.content).join('\n');
    expect(text).toContain('Quy chế quản lý tài liệu');
    expect(text).toContain('Hạng mục | Số tiền');
    expect(text).toContain('Chi phí | 2.500.000 đồng');
    expect(parts.every((c) => c.pageStart === null)).toBe(true);
    const txt = await send('legal.txt');
    expect(txt.status).toBe('READY');
    expect((await chunks(txt.id))[0]?.content).toContain('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM');
  });

  it('reports scanned, partially scanned, encrypted, malformed and bomb documents explicitly', async () => {
    expect(await send('scan.pdf')).toMatchObject({
      status: 'OCR_REQUIRED',
      errorCode: 'OCR_REQUIRED',
    });
    const mixed = await send('mixed.pdf');
    expect(mixed.status).toBe('PARTIAL');
    expect(mixed.extraction).toMatchObject({
      pagesTotal: 3,
      pagesExtracted: 2,
      pagesImageOnly: 1,
      imageOnlyPages: [2],
    });
    expect(mixed.extraction.coverage).toBeCloseTo(2 / 3);
    expect(await send('encrypted.pdf')).toMatchObject({
      status: 'FAILED',
      errorCode: 'ENCRYPTED_DOCUMENT',
    });
    expect(await send('malformed.pdf')).toMatchObject({
      status: 'FAILED',
      errorCode: 'MALFORMED_DOCUMENT',
    });
    expect(await send('bomb.docx')).toMatchObject({
      status: 'FAILED',
      errorCode: 'ARCHIVE_LIMIT_EXCEEDED',
    });
  });
});
