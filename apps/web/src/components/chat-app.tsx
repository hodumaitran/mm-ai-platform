'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChatError, streamChat } from '../lib/chat-client.ts';
import {
  MAX_MESSAGE_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  buildRequestMessages,
  conversationTitle,
  normalizeTitle,
  validateDraft,
  type ChatFailure,
  type Conversation,
  type Turn,
} from '../lib/conversation.ts';
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
  interrupted: 'Kết nối bị gián đoạn khi đang tạo câu trả lời.',
};

// After this long without any output the model is most likely being loaded into memory.
const SLOW_START_MS = 8000;

let nextId = 0;
const newId = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

export function ChatApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [generating, setGenerating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Synchronous guard: React state is stale between two events in the same tick, a ref is not.
  const busy = useRef(false);
  const composing = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const validity = validateDraft(draft);

  useEffect(() => {
    const element = scroller.current;
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight;
  }, [conversations, activeId]);

  useEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [draft]);

  const updateTurn = useCallback(
    (conversationId: string, turnId: string, change: (turn: Turn) => Turn): void => {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id !== conversationId
            ? conversation
            : {
                ...conversation,
                turns: conversation.turns.map((turn) => (turn.id === turnId ? change(turn) : turn)),
              },
        ),
      );
    },
    [],
  );

  const stop = useCallback((): void => {
    controller.current?.abort();
  }, []);

  /** The caller must already hold `busy`; it is released when the generation settles. */
  const generate = useCallback(
    async (conversationId: string, previous: Turn[], text: string): Promise<void> => {
      const turnId = newId('turn');
      const { messages, omitted } = buildRequestMessages(previous, text);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                turns: [
                  ...previous,
                  { id: turnId, user: text, assistant: '', status: 'streaming', omitted },
                ],
              }
            : conversation,
        ),
      );
      stick.current = true;
      const abort = new AbortController();
      controller.current = abort;
      setGenerating(true);
      try {
        await streamChat(
          messages,
          abort.signal,
          (delta) =>
            updateTurn(conversationId, turnId, (turn) => ({
              ...turn,
              assistant: turn.assistant + delta,
            })),
          ({ excludedTurns }) =>
            updateTurn(conversationId, turnId, (turn) => ({
              ...turn,
              omitted: omitted + excludedTurns,
            })),
        );
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
      }
    },
    [updateTurn],
  );

  const send = useCallback((): void => {
    if (busy.current || validateDraft(draft) !== 'ok') return;
    busy.current = true;
    const text = draft;
    setDraft('');
    if (active === null) {
      const id = newId('conversation');
      setConversations((current) => [
        { id, title: conversationTitle(text), turns: [] },
        ...current,
      ]);
      setActiveId(id);
      void generate(id, [], text);
    } else {
      void generate(active.id, active.turns, text);
    }
  }, [active, draft, generate]);

  /** Replace the latest turn: retry after a failure or regenerate its answer. No duplicate turn. */
  const rerun = useCallback(
    (turn: Turn): void => {
      if (busy.current || active === null) return;
      const last = active.turns.at(-1);
      if (last === undefined || last.id !== turn.id) return;
      busy.current = true;
      void generate(active.id, active.turns.slice(0, -1), turn.user);
    },
    [active, generate],
  );

  const newConversation = (): void => {
    stop();
    setActiveId(null);
    setDraft('');
    setRenaming(null);
    setConfirmingDelete(null);
    setDrawer(false);
    stick.current = true;
    textarea.current?.focus();
  };

  const select = (id: string): void => {
    if (id !== activeId) stop();
    setActiveId(id);
    setRenaming(null);
    setConfirmingDelete(null);
    setDrawer(false);
    stick.current = true;
  };

  const remove = (id: string): void => {
    if (id === activeId) {
      stop();
      setActiveId(null);
    }
    setConfirmingDelete(null);
    setConversations((current) => current.filter((conversation) => conversation.id !== id));
  };

  const commitRename = (): void => {
    if (renaming === null) return;
    const title = normalizeTitle(renaming.value);
    if (title !== null) {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === renaming.id ? { ...conversation, title } : conversation,
        ),
      );
    }
    setRenaming(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // Enter that confirms a Vietnamese/CJK IME composition must not send the message.
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    event.preventDefault();
    send();
  };

  const lastTurnId = active?.turns.at(-1)?.id ?? null;

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
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={newConversation}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-slate-100"
          >
            + Cuộc trò chuyện mới
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-slate-500">Chưa có cuộc trò chuyện nào.</p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="group flex items-center">
                  {renaming?.id === conversation.id ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      maxLength={MAX_TITLE_CHARACTERS}
                      aria-label="Tên cuộc trò chuyện"
                      onChange={(event) =>
                        setRenaming({ id: conversation.id, value: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === 'Escape') {
                          setRenaming(null);
                        }
                      }}
                      onBlur={commitRename}
                      className="min-w-0 flex-1 rounded-md border border-slate-400 bg-white px-3 py-1.5 text-sm outline-none"
                    />
                  ) : confirmingDelete === conversation.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Xác nhận xóa ${conversation.title}`}
                      className="flex min-w-0 flex-1 items-center gap-1 rounded-md bg-red-50 px-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-red-800">
                        Xóa cuộc trò chuyện?
                      </span>
                      <button
                        type="button"
                        autoFocus
                        onClick={() => remove(conversation.id)}
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
                        onClick={() => select(conversation.id)}
                        aria-current={conversation.id === activeId ? 'true' : undefined}
                        className={`min-w-0 flex-1 truncate rounded-md px-3 py-2 text-left text-sm ${
                          conversation.id === activeId
                            ? 'bg-slate-200 font-medium'
                            : 'hover:bg-slate-100'
                        }`}
                      >
                        {conversation.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmingDelete(null);
                          setRenaming({ id: conversation.id, value: conversation.title });
                        }}
                        aria-label={`Đổi tên cuộc trò chuyện ${conversation.title}`}
                        className="ml-1 rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-200 hover:text-slate-900 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                      >
                        Đổi tên
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRenaming(null);
                          setConfirmingDelete(conversation.id);
                        }}
                        aria-label={`Xóa cuộc trò chuyện ${conversation.title}`}
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
        </nav>
        <p className="border-t border-slate-200 px-4 py-3 text-xs leading-5 text-slate-500">
          Hội thoại chỉ lưu trong bộ nhớ trình duyệt và sẽ mất khi tải lại trang.
        </p>
      </aside>

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
            {active?.title ?? 'Cuộc trò chuyện mới'}
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
            {active === null || active.turns.length === 0 ? (
              <div className="py-20 text-center">
                <h2 className="text-2xl font-semibold">MM AI</h2>
                <p className="mt-2 text-slate-500">Bạn muốn hỏi điều gì hôm nay?</p>
              </div>
            ) : (
              <ol className="space-y-8">
                {active.turns.map((turn) => (
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
                  onClick={send}
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
