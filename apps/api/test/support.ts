import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
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
