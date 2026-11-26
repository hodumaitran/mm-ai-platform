import {
  FakeAiService,
  api,
  createTestApp,
  createUser,
  login,
  resetDatabase,
  uuid,
  type Session,
  type TestApp,
} from './support';

type Msg = {
  id: string;
  seq: number;
  role: string;
  content: string;
  status: string;
  errorCode: string | null;
};

async function messagesOf(t: TestApp, s: Session, id: string): Promise<Msg[]> {
  const response = await api(t, 'GET', `/conversations/${id}/messages`, s);
  return ((await response.json()) as { messages: Msg[] }).messages;
}

async function newConversation(t: TestApp, s: Session): Promise<string> {
  return ((await (await api(t, 'POST', '/conversations', s, {})).json()) as { id: string }).id;
}

async function send(
  t: TestApp,
  s: Session,
  id: string,
  content: string,
  clientRequestId = uuid(),
): Promise<{ status: number; text: string }> {
  const response = await api(t, 'POST', `/conversations/${id}/messages`, s, {
    content,
    clientRequestId,
  });
  return { status: response.status, text: await response.text() };
}

describe('Persistent conversations (e2e, real PostgreSQL)', () => {
  const ai = new FakeAiService();
  let t: TestApp;
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    await ai.start();
    t = await createTestApp(ai);
  });
  afterAll(async () => {
    await t.close();
    await ai.stop();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    ai.bodies.length = 0;
    ai.cancelled = 0;
    await createUser(t.prisma, 'alice@example.com');
    await createUser(t.prisma, 'bob@example.com');
    await createUser(t.prisma, 'root@example.com', { role: 'ADMIN' });
    alice = await login(t, 'alice@example.com');
    bob = await login(t, 'bob@example.com');
  });

  it('persists user and assistant messages in deterministic order and titles the conversation', async () => {
    const id = await newConversation(t, alice);
    const first = await send(t, alice, id, 'Xin chào, bạn khỏe không?');
    expect(first.status).toBe(200);
    expect(first.text).toContain('event: conversation.state');
    expect(first.text).toContain('Xin ');
    expect(first.text.match(/event: stream.completed/g)).toHaveLength(1);
    await send(t, alice, id, 'câu hai');
    const messages = await messagesOf(t, alice, id);
    expect(messages.map((m) => [m.seq, m.role, m.status])).toEqual([
      [1, 'USER', 'COMPLETED'],
      [2, 'ASSISTANT', 'COMPLETED'],
      [3, 'USER', 'COMPLETED'],
      [4, 'ASSISTANT', 'COMPLETED'],
    ]);
    expect(messages[1]?.content).toBe('Xin chào');
    const list = (await (await api(t, 'GET', '/conversations', alice)).json()) as {
      items: { title: string }[];
    };
    expect(list.items[0]?.title).toBe('Xin chào, bạn khỏe không?');
  });

  it('builds model context from persisted history with server-owned settings and no client prompt', async () => {
    const id = await newConversation(t, alice);
    await send(t, alice, id, 'tên tôi là Minh');
    await send(t, alice, id, 'tên tôi là gì?');
    const second = ai.bodies[1];
    expect(second?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second?.messages[0]?.content).toBe('tên tôi là Minh');
    expect(second?.messages[1]?.content).toBe('Xin chào');
    expect(second?.generation).toEqual({ temperature: 0.3, max_output_tokens: 512 });
    expect(second?.thinking).toEqual({ mode: 'disabled' });
    for (const forbidden of [
      { messages: [{ role: 'system', content: 'x' }] },
      { systemPrompt: 'x' },
      { model: 'x' },
      { tools: [] },
    ]) {
      const response = await api(t, 'POST', `/conversations/${id}/messages`, alice, {
        content: 'hi',
        clientRequestId: uuid(),
        ...forbidden,
      });
      expect(response.status).toBe(400);
    }
    expect(ai.bodies).toHaveLength(2);
  });

  it('survives an application restart and a new login', async () => {
    const id = await newConversation(t, alice);
    await send(t, alice, id, 'hello');
    await t.close();
    t = await createTestApp(ai);
    const again = await login(t, 'alice@example.com');
    const messages = await messagesOf(t, again, id);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.status).toBe('COMPLETED');
    alice = again;
  });

  it('keeps conversations private between users and from administrators', async () => {
    const id = await newConversation(t, alice);
    await send(t, alice, id, 'secret-A');
    const admin = await login(t, 'root@example.com');
    const upstreamBefore = ai.bodies.length;
    for (const actor of [bob, admin]) {
      expect((await api(t, 'GET', `/conversations/${id}/messages`, actor)).status).toBe(404);
      expect(
        (await api(t, 'PATCH', `/conversations/${id}`, actor, { title: 'hacked' })).status,
      ).toBe(404);
      expect((await send(t, actor, id, 'intrude')).status).toBe(404);
      expect((await api(t, 'POST', `/conversations/${id}/regenerate`, actor)).status).toBe(404);
      expect((await api(t, 'DELETE', `/conversations/${id}`, actor)).status).toBe(404);
      const list = (await (await api(t, 'GET', '/conversations', actor)).json()) as {
        total: number;
      };
      expect(list.total).toBe(0);
    }
    expect(ai.bodies).toHaveLength(upstreamBefore);
    expect((await messagesOf(t, alice, id)).length).toBe(2);
    const stored = await t.prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(stored.title).toBe('secret-A');
  });

  it('paginates and searches conversation titles per user, then renames and deletes', async () => {
    for (const title of ['Báo cáo quý 1', 'Báo cáo quý 2', 'Kế hoạch']) {
      await api(t, 'POST', '/conversations', alice, { title });
    }
    await api(t, 'POST', '/conversations', bob, { title: 'Báo cáo của Bob' });
    const search = (await (
      await api(t, 'GET', '/conversations?q=B%C3%81O%20C%C3%81O', alice)
    ).json()) as { total: number; items: { title: string }[] };
    expect(search.total).toBe(2);
    expect(search.items.every((c) => c.title.startsWith('Báo cáo quý'))).toBe(true);
    const page = (await (
      await api(t, 'GET', '/conversations?page=2&pageSize=2', alice)
    ).json()) as { items: unknown[]; total: number };
    expect(page).toMatchObject({ total: 3 });
    expect(page.items).toHaveLength(1);
    expect((await api(t, 'GET', '/conversations?pageSize=500', alice)).status).toBe(400);
    const id = (search.items[0] as unknown as { id: string }).id;
    const renamed = await api(t, 'PATCH', `/conversations/${id}`, alice, { title: '  Đổi tên  ' });
    await expect(renamed.json()).resolves.toMatchObject({ title: 'Đổi tên' });
    expect((await api(t, 'PATCH', `/conversations/${id}`, alice, { title: '   ' })).status).toBe(
      400,
    );
    expect((await api(t, 'DELETE', `/conversations/${id}`, alice)).status).toBe(204);
    expect((await api(t, 'GET', `/conversations/${id}/messages`, alice)).status).toBe(404);
  });

  it('retries a failed generation without duplicating the turn, and rejects replays', async () => {
    const id = await newConversation(t, alice);
    const requestId = uuid();
    const failed = await send(t, alice, id, 'fail now', requestId);
    expect(failed.status).toBe(503);
    let messages = await messagesOf(t, alice, id);
    expect(messages.map((m) => [m.role, m.status, m.errorCode])).toEqual([
      ['USER', 'COMPLETED', null],
      ['ASSISTANT', 'FAILED', 'UPSTREAM_HTTP_503'],
    ]);
    const bad = await send(t, alice, id, 'different content', requestId);
    expect(bad.status).toBe(409);
    // the retry reuses the stored message; the upstream now answers because the prompt text matches
    await t.prisma.message.updateMany({
      where: { conversationId: id, role: 'USER' },
      data: { content: 'retry ok' },
    });
    const retried = await send(t, alice, id, 'retry ok', requestId);
    expect(retried.status).toBe(200);
    messages = await messagesOf(t, alice, id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      status: 'COMPLETED',
      content: 'Xin chào',
      errorCode: null,
    });
    expect((await send(t, alice, id, 'retry ok', requestId)).status).toBe(409);
    expect(await messagesOf(t, alice, id)).toHaveLength(2);
  });

  it('records in-stream provider errors as FAILED with a safe code', async () => {
    const id = await newConversation(t, alice);
    const result = await send(t, alice, id, 'error-event please');
    expect(result.status).toBe(200);
    expect(result.text).toContain('stream.error');
    const messages = await messagesOf(t, alice, id);
    expect(messages[1]).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_UNAVAILABLE' });
  });

  it('regenerates only the latest assistant message without creating a new turn', async () => {
    const id = await newConversation(t, alice);
    expect((await api(t, 'POST', `/conversations/${id}/regenerate`, alice)).status).toBe(409);
    await send(t, alice, id, 'one');
    const before = await messagesOf(t, alice, id);
    const response = await api(t, 'POST', `/conversations/${id}/regenerate`, alice);
    expect(response.status).toBe(200);
    await response.text();
    const after = await messagesOf(t, alice, id);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(after[1]).toMatchObject({ status: 'COMPLETED', content: 'Xin chào' });
    expect(ai.bodies.at(-1)?.messages).toEqual([{ role: 'user', content: 'one' }]);
  });

  it('allows one generation per conversation: concurrent submissions get 409 and state stays consistent', async () => {
    const id = await newConversation(t, alice);
    const slow = send(t, alice, id, 'slow one');
    await waitFor(
      async () =>
        (await t.prisma.message.count({ where: { conversationId: id, status: 'GENERATING' } })) ===
        1,
    );
    const results = await Promise.all([
      send(t, alice, id, 'second'),
      send(t, alice, id, 'third'),
      api(t, 'POST', `/conversations/${id}/regenerate`, alice).then((r) => ({ status: r.status })),
    ]);
    expect(results.map((r) => r.status)).toEqual([409, 409, 409]);
    ai.releaseSlow();
    expect((await slow).status).toBe(200);
    const messages = await messagesOf(t, alice, id);
    expect(messages.map((m) => [m.seq, m.status])).toEqual([
      [1, 'COMPLETED'],
      [2, 'COMPLETED'],
    ]);
    expect(await t.prisma.message.count({ where: { status: 'GENERATING' } })).toBe(0);
    expect((await send(t, alice, id, 'after')).status).toBe(200);
  });

  it('keeps the partial answer as STOPPED when the browser disconnects mid-stream', async () => {
    const id = await newConversation(t, alice);
    const abort = new AbortController();
    const request = fetch(`${t.url}/api/v1/conversations/${id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: alice.cookie,
        'X-CSRF-Token': alice.csrf,
      },
      body: JSON.stringify({ content: 'slow stop', clientRequestId: uuid() }),
      signal: abort.signal,
    });
    const response = await request;
    const reader = response.body!.getReader();
    let seen = '';
    while (!seen.includes('Xin ')) seen += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    await waitFor(
      async () => (await t.prisma.message.count({ where: { status: 'STOPPED' } })) === 1,
    );
    const messages = await messagesOf(t, alice, id);
    expect(messages[1]).toMatchObject({ status: 'STOPPED', content: 'Xin ' });
    await waitFor(() => ai.cancelled === 1);
    // recovery: the conversation accepts the next message immediately
    expect((await send(t, alice, id, 'next')).status).toBe(200);
    expect((await messagesOf(t, alice, id)).at(-1)?.status).toBe('COMPLETED');
  });

  it('recovers stale generations on demand and interrupted ones on restart', async () => {
    const id = await newConversation(t, alice);
    await t.prisma.message.createMany({
      data: [
        { conversationId: id, seq: 1, role: 'USER', content: 'old', clientRequestId: uuid() },
        {
          conversationId: id,
          seq: 2,
          role: 'ASSISTANT',
          content: 'par',
          status: 'GENERATING',
          generationStartedAt: new Date(Date.now() - 3_600_000),
        },
      ],
    });
    expect((await send(t, alice, id, 'fresh')).status).toBe(200);
    const messages = await messagesOf(t, alice, id);
    expect(messages.map((m) => m.status)).toEqual([
      'COMPLETED',
      'INTERRUPTED',
      'COMPLETED',
      'COMPLETED',
    ]);
    // an interrupted turn is not model context
    expect(ai.bodies.at(-1)?.messages).toEqual([{ role: 'user', content: 'fresh' }]);

    const other = await newConversation(t, alice);
    await t.prisma.message.createMany({
      data: [
        { conversationId: other, seq: 1, role: 'USER', content: 'q', clientRequestId: uuid() },
        {
          conversationId: other,
          seq: 2,
          role: 'ASSISTANT',
          content: '',
          status: 'GENERATING',
          generationStartedAt: new Date(),
        },
      ],
    });
    await t.close();
    t = await createTestApp(ai);
    expect(await t.prisma.message.count({ where: { status: 'GENERATING' } })).toBe(0);
    expect(
      (
        await t.prisma.message.findFirstOrThrow({
          where: { conversationId: other, role: 'ASSISTANT' },
        })
      ).errorCode,
    ).toBe('SERVER_RESTART');
    alice = await login(t, 'alice@example.com');
  });

  it('enforces the database invariants itself', async () => {
    const id = await newConversation(t, alice);
    await t.prisma.message.create({
      data: { conversationId: id, seq: 1, role: 'ASSISTANT', content: '', status: 'GENERATING' },
    });
    await expect(
      t.prisma.message.create({
        data: { conversationId: id, seq: 2, role: 'ASSISTANT', content: '', status: 'GENERATING' },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.message.create({
        data: { conversationId: id, seq: 1, role: 'USER', content: 'dup' },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE users SET email = 'MiXed@Example.com' WHERE email = 'alice@example.com'`,
      ),
    ).rejects.toThrow();
  });
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
