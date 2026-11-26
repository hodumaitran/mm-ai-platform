import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/app.setup';
import { validateEnvironment } from '../src/config/environment';
import { PrismaService } from '../src/database/prisma.service';

export type UpstreamBody = {
  messages: { role: string; content: string }[];
  generation: unknown;
  thinking: unknown;
};

/** Fake private AI service: a real HTTP server that speaks the FastAPI SSE contract. */
export class FakeAiService {
  readonly bodies: UpstreamBody[] = [];
  cancelled = 0;
  // Document processing fake (the private Python endpoint).
  readonly docRequests: { kind: string; size: number; marker: string }[] = [];
  docCancelled = 0;
  docActive = 0;
  docMaxActive = 0;
  private readonly seenOnce = new Set<string>();
  private server!: Server;
  private release: (() => void)[] = [];
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.releaseSlow();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Lets a "slow" generation finish. */
  releaseSlow(): void {
    for (const release of this.release.splice(0)) release();
  }

  /**
   * Behaviour is chosen by a marker inside the uploaded bytes, for example [[SLOW]]: it keeps the
   * fake independent of real parsing while exercising every NestJS lifecycle path.
   */
  private async handleDocument(
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const text = body.toString('latin1');
    const marker = /\[\[([A-Z0-9]+)\]\]/.exec(text)?.[1] ?? 'OK';
    const digest = createHash('sha256').update(body).digest('hex');
    const kind = String(request.headers['x-document-kind']);
    this.docRequests.push({ kind, size: body.length, marker });
    const line = (record: unknown): void =>
      void response.write(`${JSON.stringify(record)}
`);
    const chunk = (index: number): unknown => ({
      type: 'chunk',
      index,
      content: `Điều ${index + 1}. Nội dung đoạn ${index + 1} của tài liệu.`,
      pageStart: kind === 'pdf' ? index + 1 : null,
      pageEnd: kind === 'pdf' ? index + 1 : null,
      heading: `Điều ${index + 1}`,
      section: `Chương I > Điều ${index + 1}`,
      articles: [`Điều ${index + 1}`],
      charStart: index * 100,
      charEnd: index * 100 + 60,
      estimatedTokens: 40,
    });
    const summary = (status: string, code: string | null, chunkCount: number): unknown => ({
      type: 'summary',
      status,
      code,
      metadata: { processingVersion: '1', library: 'fake', chunkCount, coverage: 1, pagesTotal: 3 },
    });
    if (marker === '503' || marker === '429') {
      response.writeHead(Number(marker), { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    if (marker === 'FLAKY' && !this.seenOnce.has(`flaky:${digest}`)) {
      this.seenOnce.add(`flaky:${digest}`);
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    this.docActive += 1;
    this.docMaxActive = Math.max(this.docMaxActive, this.docActive);
    let closed = false;
    response.once('close', () => {
      closed = true;
      this.docActive -= 1;
      if (!response.writableEnded) this.docCancelled += 1;
    });
    try {
      if (marker === 'MALFORMED') {
        line({ type: 'error', code: 'MALFORMED_DOCUMENT' });
      } else if (marker === 'OCR') {
        line(summary('OCR_REQUIRED', 'OCR_REQUIRED', 0));
      } else if (marker === 'PARTIAL') {
        line(chunk(0));
        line(chunk(1));
        line({
          ...(summary('PARTIAL', null, 2) as object),
          metadata: { chunkCount: 2, coverage: 0.5 },
        });
      } else if (marker === 'DROP') {
        line(chunk(0));
      } else if (
        marker === 'SLOW' ||
        (marker === 'SLOWFIRST' && !this.seenOnce.has(`slow:${digest}`))
      ) {
        this.seenOnce.add(`slow:${digest}`);
        line(chunk(0));
        await new Promise<void>((resolve) => this.release.push(resolve));
        if (closed) return;
        line(chunk(1));
        line(summary('READY', null, 2));
      } else {
        for (const index of [0, 1, 2]) line(chunk(index));
        line(summary('READY', null, 3));
      }
    } finally {
      if (!closed) response.end();
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    if (request.url === '/v1/documents/process') {
      await this.handleDocument(request, response, Buffer.concat(chunks));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as UpstreamBody;
    this.bodies.push(body);
    const prompt = body.messages.at(-1)?.content ?? '';
    if (prompt.startsWith('fail')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    response.write('event: stream.started\ndata: {"version":"1"}\n\n');
    response.write(
      'event: context.prepared\ndata: {"version":"1","history_turns_included":0,"history_turns_excluded":0}\n\n',
    );
    if (prompt.startsWith('error-event')) {
      response.end(
        'event: stream.error\ndata: {"version":"1","error":{"code":"MODEL_UNAVAILABLE","message":"x"}}\n\n',
      );
      return;
    }
    response.write('event: content.delta\ndata: {"content":"Xin "}\n\n');
    if (prompt.startsWith('slow')) {
      response.once('close', () => {
        this.cancelled += 1;
      });
      await new Promise<void>((resolve) => this.release.push(resolve));
      if (response.destroyed) return;
    }
    response.write('event: content.delta\ndata: {"content":"chào"}\n\n');
    response.write('event: usage.updated\ndata: {"total_tokens":2}\n\n');
    response.end('event: stream.completed\ndata: {"finish_reason":"stop"}\n\n');
  }
}

export type TestApp = {
  app: INestApplication;
  url: string;
  prisma: PrismaService;
  storageDir: string;
  ai: FakeAiService;
  close: () => Promise<void>;
};

export async function createTestApp(
  ai: FakeAiService,
  overrides: Record<string, string> = {},
): Promise<TestApp> {
  // AppModule reads process.env when it is imported, so the per-test settings are injected here.
  const environment = validateEnvironment({
    ...process.env,
    AI_SERVICE_BASE_URL: ai.baseUrl,
    AI_SERVICE_REQUEST_TIMEOUT_MS: '300000',
    DOCUMENT_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'mm-ai-docs-')),
    DOCUMENT_WORKER_ENABLED: 'false',
    ...overrides,
  });
  const config = {
    get: (key: keyof typeof environment): (typeof environment)[typeof key] => environment[key],
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({ bodyParser: false });
  configureApplication(app);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    prisma: app.get(PrismaService),
    storageDir: environment.DOCUMENT_STORAGE_DIR,
    ai,
    close: async (): Promise<void> => {
      await app.close();
    },
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (!rows[0]?.name.endsWith('_test')) throw new Error('Refusing to reset a non-test database');
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "messages", "conversations", "sessions", "users" RESTART IDENTITY CASCADE',
  );
}

export const PASSWORD = 'correct horse battery';
let passwordHash: Promise<string> | undefined;

export async function createUser(
  prisma: PrismaService,
  email: string,
  options: { role?: 'ADMIN' | 'USER'; isActive?: boolean } = {},
): Promise<{ id: string; email: string }> {
  passwordHash ??= hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const user = await prisma.user.create({
    data: {
      email,
      displayName: email.split('@')[0] ?? 'user',
      passwordHash: await passwordHash,
      role: options.role ?? 'USER',
      isActive: options.isActive ?? true,
    },
  });
  return { id: user.id, email: user.email };
}

export type Session = { cookie: string; csrf: string };

export async function login(
  t: TestApp,
  email: string,
  password = PASSWORD,
): Promise<Session & { status: number; response: Response }> {
  const response = await fetch(`${t.url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = response.headers.getSetCookie()[0] ?? '';
  const body =
    response.status === 200 ? ((await response.clone().json()) as { csrfToken: string }) : null;
  return {
    status: response.status,
    cookie: setCookie.split(';')[0] ?? '',
    csrf: body?.csrfToken ?? '',
    response,
  };
}

export async function api(
  t: TestApp,
  method: string,
  path: string,
  session: Session | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session !== null) {
    headers.Cookie = session.cookie;
    if (method !== 'GET') headers['X-CSRF-Token'] = session.csrf;
  }
  return fetch(`${t.url}/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function uuid(): string {
  return crypto.randomUUID();
}

export async function uploadDocument(
  t: TestApp,
  session: Session | null,
  filename: string,
  bytes: Buffer | string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(Buffer.from(bytes))]), filename);
  const headers: Record<string, string> = { ...extraHeaders };
  if (session !== null) {
    headers.Cookie = session.cookie;
    headers['X-CSRF-Token'] = session.csrf;
  }
  return fetch(`${t.url}/api/v1/documents`, { method: 'POST', headers, body: form });
}
