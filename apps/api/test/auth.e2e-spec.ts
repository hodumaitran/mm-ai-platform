import {
  FakeAiService,
  PASSWORD,
  api,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  uuid,
  type TestApp,
} from './support';

describe('Authentication, sessions and authorization (e2e, real PostgreSQL)', () => {
  const ai = new FakeAiService();
  let t: TestApp;

  beforeAll(async () => {
    await ai.start();
    t = await createTestApp(ai, { LOGIN_MAX_FAILURES: '5' });
  });
  afterAll(async () => {
    await t.close();
    await ai.stop();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  it('logs in with a HttpOnly SameSite cookie and never returns or stores the raw token', async () => {
    await createUser(t.prisma, 'alice@example.com');
    const session = await login(t, 'Alice@Example.com ');
    expect(session.status).toBe(200);
    const header = session.response.headers.getSetCookie()[0] ?? '';
    expect(header).toMatch(/^mm_session=/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    const token = session.cookie.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(43);
    const body = JSON.stringify(await session.response.json());
    expect(body).not.toContain(token);
    expect(body).not.toContain('passwordHash');
    const rows = await t.prisma.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(token);
    const stored = await t.prisma.user.findFirstOrThrow();
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);

    const me = await api(t, 'GET', '/auth/me', session);
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({
      user: { email: 'alice@example.com', role: 'USER' },
    });
  });

  it('gives the same generic 401 for unknown accounts, wrong passwords and disabled accounts', async () => {
    await createUser(t.prisma, 'bob@example.com');
    await createUser(t.prisma, 'off@example.com', { isActive: false });
    const results = await Promise.all([
      login(t, 'nobody@example.com'),
      login(t, 'bob@example.com', 'wrong password!!'),
      login(t, 'off@example.com'),
    ]);
    const bodies = await Promise.all(
      results.map(async (r) =>
        (await r.response.text()).replace(/"requestId":"[^"]*"|"timestamp":"[^"]*"/g, ''),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
  });

  it('rejects unauthenticated requests to every protected area', async () => {
    for (const [method, path] of [
      ['GET', '/auth/me'],
      ['GET', '/conversations'],
      ['POST', '/conversations'],
      ['GET', '/users'],
      ['POST', `/conversations/${uuid()}/messages`],
    ] as const) {
      const response = await api(t, method, path, null, method === 'POST' ? {} : undefined);
      expect([path, response.status]).toEqual([path, 401]);
    }
    const bad = await api(t, 'GET', '/auth/me', { cookie: 'mm_session=forged', csrf: '' });
    expect(bad.status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    await createUser(t.prisma, 'carol@example.com');
    const session = await login(t, 'carol@example.com');
    expect((await api(t, 'POST', '/auth/logout', session)).status).toBe(204);
    expect((await api(t, 'GET', '/auth/me', session)).status).toBe(401);
    const row = await t.prisma.session.findFirstOrThrow();
    expect(row.revokedAt).not.toBeNull();
  });

  it('rejects an expired session', async () => {
    await createUser(t.prisma, 'dave@example.com');
    const session = await login(t, 'dave@example.com');
    await t.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api(t, 'GET', '/auth/me', session)).status).toBe(401);
  });

  it('requires a valid CSRF token and an allowed Origin for state-changing requests', async () => {
    await createUser(t.prisma, 'erin@example.com');
    const session = await login(t, 'erin@example.com');
    const noToken = await api(t, 'POST', '/conversations', { ...session, csrf: '' }, {});
    const wrong = await api(t, 'POST', '/conversations', { ...session, csrf: 'x'.repeat(43) }, {});
    const evil = await api(
      t,
      'POST',
      '/conversations',
      session,
      {},
      { Origin: 'https://evil.example' },
    );
    const good = await api(
      t,
      'POST',
      '/conversations',
      session,
      {},
      { Origin: 'http://127.0.0.1:3000' },
    );
    expect([noToken.status, wrong.status, evil.status, good.status]).toEqual([403, 403, 403, 201]);
    expect((await api(t, 'GET', '/conversations', { ...session, csrf: '' })).status).toBe(200);
    const login403 = await fetch(`${t.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'erin@example.com', password: PASSWORD }),
    });
    expect(login403.status).toBe(403);
  });

  it('rate-limits repeated failed logins and blocks even the correct password afterwards', async () => {
    await createUser(t.prisma, 'frank@example.com');
    for (let i = 0; i < 5; i += 1)
      expect((await login(t, 'frank@example.com', 'bad bad bad bad')).status).toBe(401);
    const blocked = await login(t, 'frank@example.com');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await login(t, 'other@example.com')).status).toBe(401);
  });

  it('enforces roles: USER cannot use administrator endpoints', async () => {
    await createUser(t.prisma, 'user@example.com');
    const session = await login(t, 'user@example.com');
    expect((await api(t, 'GET', '/users', session)).status).toBe(403);
    const create = await api(t, 'POST', '/users', session, {
      email: 'x@example.com',
      displayName: 'X',
      password: 'a very long password',
      role: 'ADMIN',
    });
    expect(create.status).toBe(403);
    expect(await t.prisma.user.count()).toBe(1);
  });

  it('lets an administrator create, list (paginated) and deactivate accounts', async () => {
    await createUser(t.prisma, 'root@example.com', { role: 'ADMIN' });
    const admin = await login(t, 'root@example.com');
    const created = await api(t, 'POST', '/users', admin, {
      email: ' New.Person@Example.com ',
      displayName: 'New Person',
      password: 'a very long password',
    });
    expect(created.status).toBe(201);
    const user = (await created.json()) as {
      id: string;
      email: string;
      role: string;
      passwordHash?: string;
    };
    expect(user).toMatchObject({ email: 'new.person@example.com', role: 'USER' });
    expect(user.passwordHash).toBeUndefined();
    expect(
      (
        await api(t, 'POST', '/users', admin, {
          email: 'new.person@example.com',
          displayName: 'D',
          password: 'a very long password',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api(t, 'POST', '/users', admin, {
          email: 'w@example.com',
          displayName: 'W',
          password: 'short',
        })
      ).status,
    ).toBe(400);
    const page = await api(t, 'GET', '/users?page=2&pageSize=1', admin);
    await expect(page.json()).resolves.toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect((await api(t, 'GET', '/users?pageSize=1000', admin)).status).toBe(400);

    const session = await login(t, 'new.person@example.com', 'a very long password');
    expect(session.status).toBe(200);
    expect((await api(t, 'PATCH', `/users/${user.id}`, admin, { isActive: false })).status).toBe(
      200,
    );
    expect((await api(t, 'GET', '/auth/me', session)).status).toBe(401);
    expect((await login(t, 'new.person@example.com', 'a very long password')).status).toBe(401);
    const self = (await t.prisma.user.findFirstOrThrow({ where: { email: 'root@example.com' } }))
      .id;
    expect((await api(t, 'PATCH', `/users/${self}`, admin, { isActive: false })).status).toBe(400);
    expect((await api(t, 'PATCH', `/users/${user.id}`, admin, { isActive: true })).status).toBe(
      200,
    );
    expect((await login(t, 'new.person@example.com', 'a very long password')).status).toBe(200);
  });

  it('reports database readiness without connection details', async () => {
    const response = await fetch(`${t.url}/api/v1/health/ready`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ service: 'api', status: 'ok', database: 'up' });
    expect(text).not.toContain('postgresql');
  });
});
