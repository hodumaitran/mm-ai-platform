'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { apiJson } from '../lib/api.ts';
import { ChatError, streamReply, type GenerationRequest } from '../lib/chat-client.ts';
import {
  MAX_MESSAGE_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  messagesToTurns,
  normalizeTitle,
  validateDraft,
  type ChatFailure,
  type ConversationSummary,
  type ServerMessage,
  type Turn,
} from '../lib/conversation.ts';
import { AdminPanel } from './admin-panel.tsx';
import { DocumentsView } from './documents-view.tsx';
import type { SessionUser } from './login-form.tsx';
import { CopyButton, Markdown } from './markdown.tsx';

const FAILURE_TEXT: Record<ChatFailure['kind'], string> = {
  invalid: 'Yêu cầu không hợp lệ. Hãy rút gọn nội dung và thử lại.',
  context:
    'Cuộc trò chuyện vượt quá giới hạn ngữ cảnh của mô hình. Hãy rút gọn tin nhắn hoặc bắt đầu cuộc trò chuyện mới.',
  capacity: 'Hệ thống đang xử lý quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
  unavailable: 'Mô hình AI hiện không khả dụng. Hãy kiểm tra dịch vụ AI nội bộ rồi thử lại.',
  timeout: 'Yêu cầu vượt quá thời gian chờ. Vui lòng thử lại.',
  network: 'Không thể kết nối tới máy chủ. Hãy kiểm tra kết nối và thử lại.',
  server: 'Đã xảy ra lỗi khi xử lý yêu cầu. Vui lòng thử lại.',
  interrupted: 'Câu trả lời bị gián đoạn trước khi hoàn tất.',
  conflict: 'Cuộc trò chuyện này đang tạo một câu trả lời khác. Hãy đợi hoặc dừng nó rồi thử lại.',
  notfound: 'Không tìm thấy cuộc trò chuyện này.',
  unauthorized: 'Phiên đăng nhập đã hết hạn.',
};

// After this long without any output the model is most likely being loaded into memory.
const SLOW_START_MS = 8000;
const PAGE_SIZE = 30;

function readHashId(): string | null {
  const match = /^#c=([0-9a-fA-F-]{36})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

function writeHashId(id: string | null): void {
  const next = id === null ? window.location.pathname : `${window.location.pathname}#c=${id}`;
  window.history.replaceState(null, '', next);
}

export function ChatApp({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [listPage, setListPage] = useState(1);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsState, setTurnsState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [draft, setDraft] = useState('');
  const [generating, setGenerating] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [view, setView] = useState<'chat' | 'documents'>('chat');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Synchronous guard: React state is stale between two events in the same tick, a ref is not.
  const busy = useRef(false);
  const composing = useRef(false);
  const activeRef = useRef<string | null>(null);
  const queryRef = useRef('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const activeSummary = list.find((item) => item.id === activeId) ?? null;
  const validity = validateDraft(draft);
  const lastTurnId = turns.at(-1)?.id ?? null;

  useEffect(() => {
    const element = scroller.current;
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight;
  }, [turns, activeId]);

  useEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [draft]);

  const loadList = useCallback(
    async (text: string, page: number, append: boolean): Promise<void> => {
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        if (text.trim() !== '') params.set('q', text.trim());
        const result = await apiJson<{ items: ConversationSummary[]; total: number }>(
          'GET',
          `/conversations?${params.toString()}`,
        );
        if (queryRef.current !== text) return;
        setList((current) => (append ? [...current, ...result.items] : result.items));
        setListTotal(result.total);
        setListPage(page);
        setListState('ready');
      } catch {
        if (queryRef.current === text) setListState('error');
      }
    },
    [],
  );

  const refreshList = useCallback((): void => {
    void loadList(queryRef.current, 1, false);
  }, [loadList]);

  // Debounced title search (server-side, scoped to the signed-in user).
  useEffect(() => {
    const timer = setTimeout(() => {
      queryRef.current = search;
      setQuery(search);
      setListState('loading');
      void loadList(search, 1, false);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, loadList]);

  const openConversation = useCallback(async (id: string): Promise<void> => {
    controller.current?.abort();
    activeRef.current = id;
    setActiveId(id);
    writeHashId(id);
    setTurns([]);
    setTurnsState('loading');
    setBanner(null);
    stick.current = true;
    try {
      const result = await apiJson<{ messages: ServerMessage[] }>(
        'GET',
        `/conversations/${id}/messages`,
      );
      if (activeRef.current !== id) return;
      setTurns(messagesToTurns(result.messages));
      setTurnsState('idle');
    } catch {
      if (activeRef.current !== id) return;
      activeRef.current = null;
      setActiveId(null);
      writeHashId(null);
      setTurnsState('idle');
      setBanner('Không mở được cuộc trò chuyện này.');
    }
  }, []);

  // Restore the conversation that was open before a page refresh.
  useEffect(() => {
    const id = readHashId();
    if (id === null) return;
    const timer = setTimeout(() => void openConversation(id), 0);
    return () => clearTimeout(timer);
  }, [openConversation]);

  const updateTurn = useCallback(
    (conversationId: string, turnId: string, change: (turn: Turn) => Turn): void => {
      if (activeRef.current !== conversationId) return;
      setTurns((current) => current.map((turn) => (turn.id === turnId ? change(turn) : turn)));
    },
    [],
  );

  const stop = useCallback((): void => {
    controller.current?.abort();
  }, []);

  /** The caller must already hold `busy`; it is released when the generation settles. */
  const generate = useCallback(
    async (
      conversationId: string,
      previous: Turn[],
      userText: string,
      request: GenerationRequest,
    ): Promise<void> => {
      const turnId = `turn-${crypto.randomUUID()}`;
      setTurns([
        ...previous,
        {
          id: turnId,
          user: userText,
          assistant: '',
          status: 'streaming',
          clientRequestId: request.kind === 'send' ? request.clientRequestId : undefined,
        },
      ]);
      stick.current = true;
      const abort = new AbortController();
      controller.current = abort;
      setGenerating(true);
      try {
        await streamReply(conversationId, request, abort.signal, {
          onDelta: (delta) =>
            updateTurn(conversationId, turnId, (turn) => ({
              ...turn,
              assistant: turn.assistant + delta,
            })),
          onOmitted: (omitted) =>
            updateTurn(conversationId, turnId, (turn) => ({ ...turn, omitted })),
          onState: ({ title }) =>
            setList((current) =>
              current.map((item) => (item.id === conversationId ? { ...item, title } : item)),
            ),
        });
        updateTurn(conversationId, turnId, (turn) => ({ ...turn, status: 'done' }));
      } catch (error) {
        if (abort.signal.aborted) {
          updateTurn(conversationId, turnId, (turn) => ({ ...turn, status: 'stopped' }));
        } else {
          const failure = error instanceof ChatError ? error.failure : { kind: 'network' as const };
          updateTurn(conversationId, turnId, (turn) => ({
            ...turn,
            status: 'error',
            error: failure,
          }));
        }
      } finally {
        if (controller.current === abort) controller.current = null;
        busy.current = false;
        setGenerating(false);
        refreshList();
      }
    },
    [refreshList, updateTurn],
  );

  const send = useCallback(async (): Promise<void> => {
    if (busy.current || validateDraft(draft) !== 'ok') return;
    busy.current = true;
    const text = draft;
    setDraft('');
    let conversationId = activeRef.current;
    let previous = turns;
    if (conversationId === null) {
      try {
        const created = await apiJson<ConversationSummary>('POST', '/conversations', { body: {} });
        conversationId = created.id;
        activeRef.current = created.id;
        setActiveId(created.id);
        writeHashId(created.id);
        setList((current) => [created, ...current]);
        previous = [];
      } catch {
        busy.current = false;
        setDraft(text);
        setBanner('Không tạo được cuộc trò chuyện. Vui lòng thử lại.');
        return;
      }
    }
    setBanner(null);
    await generate(conversationId, previous, text, {
      kind: 'send',
      content: text,
      clientRequestId: crypto.randomUUID(),
    });
  }, [draft, generate, turns]);

  /** Retry after a failure or regenerate the answer: only for the latest turn, no duplicate turn. */
  const rerun = useCallback(
    (turn: Turn): void => {
      const conversationId = activeRef.current;
      if (busy.current || conversationId === null || turn.id !== lastTurnId) return;
      busy.current = true;
      const previous = turns.slice(0, -1);
      // An in-session submission keeps its idempotency key (the server may not have stored it yet);
      // a restored or completed turn already exists server-side and is regenerated in place.
      const request: GenerationRequest =
        turn.status === 'error' && turn.clientRequestId !== undefined
          ? { kind: 'send', content: turn.user, clientRequestId: turn.clientRequestId }
          : { kind: 'regenerate' };
      void generate(conversationId, previous, turn.user, request);
    },
    [generate, lastTurnId, turns],
  );

  const newConversation = (): void => {
    setView('chat');
    stop();
    activeRef.current = null;
    setActiveId(null);
    writeHashId(null);
    setTurns([]);
    setDraft('');
    setBanner(null);
    setRenaming(null);
    setConfirmingDelete(null);
    setDrawer(false);
    stick.current = true;
    textarea.current?.focus();
  };

  const select = (id: string): void => {
    setView('chat');
    if (id === activeRef.current) {
      setDrawer(false);
      return;
    }
    setRenaming(null);
    setConfirmingDelete(null);
    setDrawer(false);
    void openConversation(id);
  };

  const remove = async (id: string): Promise<void> => {
    setConfirmingDelete(null);
    if (id === activeRef.current) newConversation();
    try {
      await apiJson('DELETE', `/conversations/${id}`);
      setList((current) => current.filter((item) => item.id !== id));
      setListTotal((total) => Math.max(0, total - 1));
    } catch {
      setBanner('Không xóa được cuộc trò chuyện.');
      refreshList();
    }
  };

  const commitRename = async (): Promise<void> => {
    if (renaming === null) return;
    const { id } = renaming;
    const title = normalizeTitle(renaming.value);
    setRenaming(null);
    if (title === null) return;
    try {
      const updated = await apiJson<ConversationSummary>('PATCH', `/conversations/${id}`, {
        body: { title },
      });
      setList((current) =>
        current.map((item) => (item.id === id ? { ...item, title: updated.title } : item)),
      );
    } catch {
      setBanner('Không đổi được tên cuộc trò chuyện.');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // Enter that confirms a Vietnamese/CJK IME composition must not send the message.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    event.preventDefault();
    void send();
  };

  return (
    <div className="flex h-dvh bg-white text-slate-900">
      {drawer && (
        <button
          type="button"
          aria-label="Đóng thanh bên"
          className="fixed inset-0 z-20 bg-slate-900/30 md:hidden"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside
        aria-label="Danh sách cuộc trò chuyện"
        className={`fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-slate-200 bg-slate-50 transition-transform md:static md:translate-x-0 ${
          drawer ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'md:hidden' : ''}`}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold tracking-wide">MM AI</span>
          <button
            type="button"
            onClick={() => {
              setCollapsed(true);
              setDrawer(false);
            }}
            className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200"
          >
            Thu gọn
          </button>
        </div>
        <div className="flex gap-1 px-3 pb-2" role="tablist" aria-label="Không gian làm việc">
          {(['chat', 'documents'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => {
                setView(tab);
                setDrawer(false);
              }}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm ${
                view === tab ? 'bg-slate-200 font-medium' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {tab === 'chat' ? 'Trò chuyện' : 'Tài liệu'}
            </button>
          ))}
        </div>
        <div className="space-y-2 px-3 pb-2">
          <button
            type="button"
            onClick={newConversation}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-slate-100"
          >
            + Cuộc trò chuyện mới
          </button>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={80}
            aria-label="Tìm theo tiêu đề"
            placeholder="Tìm theo tiêu đề…"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-500"
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {listState === 'loading' && list.length === 0 ? (
            <p role="status" className="px-2 py-3 text-xs text-slate-500">
              Đang tải…
            </p>
          ) : listState === 'error' ? (
            <p role="alert" className="px-2 py-3 text-xs text-red-700">
              Không tải được danh sách.{' '}
              <button type="button" onClick={refreshList} className="underline">
                Thử lại
              </button>
            </p>
          ) : list.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">
              {query.trim() !== ''
                ? 'Không có cuộc trò chuyện nào khớp.'
                : 'Chưa có cuộc trò chuyện nào.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {list.map((item) => (
                <li key={item.id} className="group flex items-center">
                  {renaming?.id === item.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      maxLength={MAX_TITLE_CHARACTERS}
                      aria-label="Tên cuộc trò chuyện"
                      onChange={(event) => setRenaming({ id: item.id, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void commitRename();
                        } else if (event.key === 'Escape') {
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => void commitRename()}
                      className="min-w-0 flex-1 rounded-md border border-slate-400 bg-white px-3 py-1.5 text-sm outline-none"
                    />
                  ) : confirmingDelete === item.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Xác nhận xóa ${item.title}`}
                      className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-red-800">
                        Xóa cuộc trò chuyện?
                      </span>
                      <button
                        type="button"
                        autoFocus
                        onClick={() => void remove(item.id)}
                        className="rounded px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100"
                      >
                        Xóa
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(null)}
                        className="rounded px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-200"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => select(item.id)}
                        aria-current={item.id === activeId ? 'true' : undefined}
                        className={`min-w-0 flex-1 truncate rounded-md px-3 py-2 text-left text-sm ${
                          item.id === activeId ? 'bg-slate-200 font-medium' : 'hover:bg-slate-100'
                        }`}
                      >
                        {item.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingDelete(null);
                          setRenaming({ id: item.id, value: item.title });
                        }}
                        aria-label={`Đổi tên cuộc trò chuyện ${item.title}`}
                        className="ml-1 rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-900 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      >
                        Đổi tên
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRenaming(null);
                          setConfirmingDelete(item.id);
                        }}
                        aria-label={`Xóa cuộc trò chuyện ${item.title}`}
                        className="rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-900 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      >
                        Xóa
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {list.length < listTotal && (
            <button
              type="button"
              onClick={() => void loadList(queryRef.current, listPage + 1, true)}
              className="mt-1 w-full rounded px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-200"
            >
              Tải thêm
            </button>
          )}
        </nav>
        <div className="relative border-t border-slate-200 px-3 py-2">
          {menu && (
            <div
              role="menu"
              className="absolute right-3 bottom-14 left-3 rounded-md border border-slate-200 bg-white p-1 shadow-md"
            >
              <p className="truncate px-3 py-1.5 text-xs text-slate-500">{user.email}</p>
              {user.role === 'ADMIN' && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setAdmin(true);
                  }}
                  className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-slate-100"
                >
                  Quản lý người dùng
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={onLogout}
                className="w-full rounded px-3 py-1.5 text-left text-sm hover:bg-slate-100"
              >
                Đăng xuất
              </button>
            </div>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
            className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-200"
          >
            <span className="min-w-0 truncate font-medium">{user.displayName}</span>
            <span className="ml-2 text-xs text-slate-500">
              {user.role === 'ADMIN' ? 'Quản trị' : 'Nhân viên'}
            </span>
          </button>
          <p className="px-2 pt-1 text-xs leading-5 text-slate-500">
            Hội thoại được lưu trên máy chủ nội bộ và chỉ bạn xem được.
          </p>
        </div>
      </aside>

      {view === 'documents' ? (
        <DocumentsView onOpenList={() => setDrawer(true)} />
      ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <button
              type="button"
              onClick={() => {
                setCollapsed(false);
                setDrawer(true);
              }}
              className={`rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 ${
                collapsed ? '' : 'md:hidden'
              }`}
            >
              Danh sách
            </button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeSummary?.title ?? 'Cuộc trò chuyện mới'}
            </h1>
            <span className="hidden text-xs text-slate-500 sm:inline">Mô hình cục bộ · MM AI</span>
          </header>

          <div
            ref={scroller}
            onScroll={(event) => {
              const element = event.currentTarget;
              stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto w-full max-w-3xl px-4 py-6">
              {turnsState === 'loading' ? (
                <p role="status" className="py-20 text-center text-sm text-slate-500">
                  Đang tải cuộc trò chuyện…
                </p>
              ) : turns.length === 0 ? (
                <div className="py-20 text-center">
                  <h2 className="text-2xl font-semibold">MM AI</h2>
                  <p className="mt-2 text-slate-500">Bạn muốn hỏi điều gì hôm nay?</p>
                </div>
              ) : (
                <ol className="space-y-8">
                  {turns.map((turn) => (
                    <li key={turn.id} className="space-y-4">
                      <div className="flex justify-end">
                        <p className="max-w-[85%] rounded-2xl bg-slate-100 px-4 py-2.5 text-sm break-words whitespace-pre-wrap">
                          {turn.user}
                        </p>
                      </div>
                      <TurnView
                        turn={turn}
                        onRerun={() => rerun(turn)}
                        canRerun={!generating && turn.id === lastTurnId}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div className="border-t border-slate-200 bg-white px-4 pt-3 pb-3">
            <div className="mx-auto w-full max-w-3xl">
              {banner !== null && (
                <p role="alert" className="mb-2 text-xs text-red-700">
                  {banner}
                </p>
              )}
              <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white p-2 focus-within:border-slate-500">
                <textarea
                  ref={textarea}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  rows={1}
                  aria-label="Nhập tin nhắn"
                  placeholder="Nhập tin nhắn…"
                  title="Enter để gửi, Shift+Enter để xuống dòng"
                  className="max-h-52 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
                />
                {generating ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
                  >
                    Dừng
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={validity !== 'ok'}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    Gửi
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                <span className={validity === 'too-long' ? 'text-red-700' : ''}>
                  {validity === 'too-long'
                    ? `Tin nhắn dài quá ${MAX_MESSAGE_CHARACTERS} ký tự. Hãy rút gọn trước khi gửi.`
                    : 'MM AI có thể mắc lỗi. Hãy kiểm tra thông tin quan trọng.'}
                </span>
                <span>
                  {draft.length}/{MAX_MESSAGE_CHARACTERS}
                </span>
              </div>
            </div>
          </div>
        </main>
      )}
      {admin && <AdminPanel currentUserId={user.id} onClose={() => setAdmin(false)} />}
    </div>
  );
}

function TurnView({
  turn,
  onRerun,
  canRerun,
}: {
  turn: Turn;
  onRerun: () => void;
  canRerun: boolean;
}) {
  const waiting = turn.status === 'streaming' && turn.assistant === '';

  return (
    <div className="text-sm leading-6">
      <p className="mb-1 text-xs font-semibold text-slate-500">MM AI</p>
      {waiting && (
        <p role="status" className="text-slate-500">
          Đang tạo câu trả lời…
          <SlowStartHint />
        </p>
      )}
      {turn.assistant !== '' && <Markdown text={turn.assistant} />}
      {turn.status === 'streaming' && turn.assistant !== '' && (
        <p role="status" className="mt-1 text-xs text-slate-400">
          Đang tạo…
        </p>
      )}
      {turn.status === 'stopped' && (
        <p className="mt-1 text-xs text-slate-500">Đã dừng tạo câu trả lời.</p>
      )}
      {turn.omitted !== undefined && turn.omitted > 0 && (
        <p role="note" className="mt-1 text-xs text-amber-700">
          {turn.omitted} lượt trò chuyện trước đó không nằm trong ngữ cảnh của câu trả lời này do
          giới hạn ngữ cảnh của mô hình.
        </p>
      )}
      {turn.status === 'error' && turn.error !== undefined && (
        <div role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
          <p className="text-red-800">{FAILURE_TEXT[turn.error.kind]}</p>
          {canRerun && (
            <button
              type="button"
              onClick={onRerun}
              className="mt-1 text-xs font-medium text-red-800 underline"
            >
              Thử lại
            </button>
          )}
        </div>
      )}
      {turn.assistant !== '' && turn.status !== 'streaming' && (
        <div className="mt-1 -ml-2 flex items-center gap-1">
          <CopyButton text={turn.assistant} label="Sao chép câu trả lời" />
          {canRerun && turn.status !== 'error' && (
            <button
              type="button"
              onClick={onRerun}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              Tạo lại
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Mounted only while waiting for the first output, so the timer needs no reset logic. */
function SlowStartHint() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!slow) return null;
  return (
    <span className="block text-xs text-slate-400">
      Mô hình có thể đang được nạp vào bộ nhớ; lần đầu có thể mất vài phút.
    </span>
  );
}
