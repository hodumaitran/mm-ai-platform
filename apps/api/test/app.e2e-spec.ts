import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/app.setup';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

describe('Health endpoint (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: 'api', status: 'ok' });
  });

  it('returns a sanitized error contract without echoing query strings', async () => {
    const response = await fetch(`${await app.getUrl()}/api/v1/missing?token=private`);
    expect(response.status).toBe(404);
    const payload: unknown = await response.json();
    expect(isRecord(payload)).toBe(true);
    if (!isRecord(payload)) {
      throw new Error('Expected an object error response');
    }
    expect(payload.error).toBe('Request failed');
    expect(payload.path).toBe('/api/v1/missing');
    expect(payload.statusCode).toBe(404);
    expect(typeof payload.timestamp).toBe('string');
    expect(JSON.stringify(payload)).not.toContain('private');
  });
});
