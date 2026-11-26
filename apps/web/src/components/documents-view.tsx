'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ApiError, apiJson } from '../lib/api.ts';
import {
  STATUS_LABEL,
  errorText,
  formatBytes,
  isActive,
  uploadFile,
  validateFile,
  type DocumentChunk,
  type DocumentItem,
  type DocumentKind,
  type DocumentStatus,
} from '../lib/documents.ts';

const PAGE_SIZE = 10;
const CHUNK_PAGE_SIZE = 5;
const POLL_MS = 2000;

type UploadEntry = {
  key: string;
  name: string;
  progress: number;
  state: 'waiting' | 'uploading' | 'error';
  message?: string;
};

type DocumentPage = { items: DocumentItem[]; total: number };

const STATUS_STYLE: Record<DocumentStatus, string> = {
  PENDING: 'bg-slate-100 text-slate-700',
  PROCESSING: 'bg-blue-50 text-blue-800',
  READY: 'bg-green-50 text-green-800',
  PARTIAL: 'bg-amber-50 text-amber-800',
  FAILED: 'bg-red-50 text-red-800',
  OCR_REQUIRED: 'bg-amber-50 text-amber-800',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function StatusBadge({ status }: { status: DocumentStatus }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DocumentsView({ onOpenList }: { onOpenList: () => void }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DocumentPage | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'' | DocumentStatus>('');
  const [kind, setKind] = useState<'' | DocumentKind>('');
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const filters = useRef({ page: 1, query: '', status: '', kind: '' });
  const queue = useRef<{ key: string; file: File }[]>([]);
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const current = filters.current;
    const params = new URLSearchParams({ page: String(current.page), pageSize: String(PAGE_SIZE) });
    if (current.query.trim() !== '') params.set('q', current.query.trim());
    if (current.status !== '') params.set('status', current.status);
    if (current.kind !== '') params.set('kind', current.kind);
    try {
      const result = await apiJson<DocumentPage>('GET', `/documents?${params.toString()}`);
      if (filters.current !== current) return;
      setData(result);
      setLoadState('ready');
    } catch {
      if (filters.current === current) setLoadState('error');
    }
  }, []);

  // Filters change the request: keep a stable snapshot object so late responses can be ignored.
  const applyFilters = useCallback(
    (next: Partial<{ page: number; query: string; status: string; kind: string }>): void => {
      filters.current = { ...filters.current, ...next };
      void load();
    },
    [load],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      applyFilters({ query: search, page: 1 });
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, applyFilters]);

  // Poll while something is still being processed (also covers the open detail panel).
  const busy = data?.items.some((item) => isActive(item.status)) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const processQueue = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length > 0) {
      const next = queue.current.shift();
      if (next === undefined) break;
      const controller = new AbortController();
      abort.current = controller;
      setUploads((current) =>
        current.map((entry) => (entry.key === next.key ? { ...entry, state: 'uploading' } : entry)),
      );
      const result = await uploadFile(
        next.file,
        (progress) =>
          setUploads((current) =>
            current.map((entry) => (entry.key === next.key ? { ...entry, progress } : entry)),
          ),
        controller.signal,
      );
      if (result.ok) {
        setUploads((current) => current.filter((entry) => entry.key !== next.key));
        void load();
      } else {
        setUploads((current) =>
          current.map((entry) =>
            entry.key === next.key ? { ...entry, state: 'error', message: result.message } : entry,
          ),
        );
      }
    }
    running.current = false;
  }, [load]);

  const addFiles = useCallback(
    (files: FileList | File[]): void => {
      const entries: UploadEntry[] = [];
      for (const file of Array.from(files)) {
        const key = `${crypto.randomUUID()}`;
        const problem = validateFile(file);
        if (problem !== null) {
          entries.push({ key, name: file.name, progress: 0, state: 'error', message: problem });
        } else {
          entries.push({ key, name: file.name, progress: 0, state: 'waiting' });
          queue.current.push({ key, file });
        }
      }
      setUploads((current) => [...current, ...entries]);
      void processQueue();
    },
    [processQueue],
  );

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  };

  const pages = data === null ? 1 : Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const hasFilters = query.trim() !== '' || status !== '' || kind !== '';

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <button
          type="button"
          onClick={onOpenList}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 md:hidden"
        >
          Danh sách
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">Tài liệu</h1>
        <span className="hidden text-xs text-slate-500 sm:inline">
          Chỉ bạn xem được tài liệu của mình
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-5">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm ${
              dragging ? 'border-slate-500 bg-slate-50' : 'border-slate-300'
            }`}
          >
            <p className="text-slate-700">Kéo thả tệp PDF, DOCX hoặc TXT vào đây</p>
            <p className="mt-1 text-xs text-slate-500">
              Tối đa {formatBytes(50 * 1024 * 1024)} mỗi tệp
            </p>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="mt-3 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Chọn tệp
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept=".pdf,.docx,.txt"
              aria-label="Chọn tệp để tải lên"
              className="hidden"
              onChange={(event) => {
                if (event.target.files !== null) addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </div>

          {uploads.length > 0 && (
            <ul className="mt-3 space-y-2" aria-label="Tiến trình tải lên">
              {uploads.map((entry) => (
                <li
                  key={entry.key}
                  className="rounded-md border border-slate-200 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{entry.name}</span>
                    {entry.state === 'error' ? (
                      <button
                        type="button"
                        onClick={() => setUploads((c) => c.filter((e) => e.key !== entry.key))}
                        className="text-xs text-slate-500 underline"
                      >
                        Bỏ qua
                      </button>
                    ) : (
                      <span className="text-xs text-slate-500">
                        {entry.state === 'waiting'
                          ? 'Đang chờ'
                          : `${Math.round(entry.progress * 100)}%`}
                      </span>
                    )}
                  </div>
                  {entry.state === 'error' ? (
                    <p role="alert" className="mt-1 text-xs text-red-700">
                      {entry.message}
                    </p>
                  ) : (
                    <div className="mt-1 h-1.5 rounded bg-slate-100">
                      <div
                        className="h-1.5 rounded bg-slate-700"
                        style={{ width: `${Math.round(entry.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={100}
              aria-label="Tìm theo tên tệp"
              placeholder="Tìm theo tên tệp…"
              className="w-full min-w-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-500 sm:w-auto sm:flex-1"
            />
            <select
              aria-label="Lọc theo trạng thái"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as '' | DocumentStatus);
                setPage(1);
                applyFilters({ status: event.target.value, page: 1 });
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Mọi trạng thái</option>
              {(Object.keys(STATUS_LABEL) as DocumentStatus[]).map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
            <select
              aria-label="Lọc theo loại tệp"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as '' | DocumentKind);
                setPage(1);
                applyFilters({ kind: event.target.value, page: 1 });
              }}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Mọi loại</option>
              <option value="PDF">PDF</option>
              <option value="DOCX">DOCX</option>
              <option value="TXT">TXT</option>
            </select>
          </div>

          <div className="mt-3">
            {loadState === 'loading' && data === null ? (
              <p role="status" className="py-10 text-center text-sm text-slate-500">
                Đang tải danh sách tài liệu…
              </p>
            ) : loadState === 'error' ? (
              <p role="alert" className="py-10 text-center text-sm text-red-700">
                Không tải được danh sách tài liệu.{' '}
                <button type="button" onClick={() => void load()} className="underline">
                  Thử lại
                </button>
              </p>
            ) : data !== null && data.items.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-500">
                {hasFilters
                  ? 'Không có tài liệu nào khớp bộ lọc.'
                  : 'Chưa có tài liệu nào. Hãy tải lên tệp đầu tiên của bạn.'}
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {data?.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      aria-label={`Mở tài liệu ${item.originalFilename}`}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-slate-50"
                    >
                      <span className="min-w-0 flex-1 basis-48 truncate text-sm font-medium">
                        {item.originalFilename}
                      </span>
                      <span className="text-xs text-slate-500">
                        {item.kind} · {formatBytes(item.sizeBytes)} · {formatDate(item.createdAt)}
                      </span>
                      <StatusBadge status={item.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data !== null && data.total > 0 && (
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <span>
                Trang {page}/{pages} · {data.total} tài liệu
              </span>
              <span className="space-x-1">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage(page - 1);
                    applyFilters({ page: page - 1 });
                  }}
                  className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                >
                  Trước
                </button>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => {
                    setPage(page + 1);
                    applyFilters({ page: page + 1 });
                  }}
                  className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                >
                  Sau
                </button>
              </span>
            </div>
          )}
        </div>
      </div>

      {selectedId !== null && (
        <DocumentDetail
          key={selectedId}
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
          onDeleted={() => {
            setSelectedId(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function DocumentDetail({
  id,
  onClose,
  onChanged,
  onDeleted,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [chunkPage, setChunkPage] = useState(1);
  const [chunks, setChunks] = useState<{ items: DocumentChunk[]; total: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const status = document?.status;

  const loadDocument = useCallback(async (): Promise<void> => {
    try {
      setDocument(await apiJson<DocumentItem>('GET', `/documents/${id}`));
      setState('ready');
    } catch (error) {
      setState(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
    }
  }, [id]);

  const loadChunks = useCallback(async (): Promise<void> => {
    try {
      setChunks(
        await apiJson<{ items: DocumentChunk[]; total: number }>(
          'GET',
          `/documents/${id}/chunks?page=${chunkPage}&pageSize=${CHUNK_PAGE_SIZE}`,
        ),
      );
    } catch {
      setChunks(null);
    }
  }, [id, chunkPage]);

  useEffect(() => {
    const timer = setTimeout(() => void loadDocument(), 0);
    return () => clearTimeout(timer);
  }, [loadDocument]);

  useEffect(() => {
    if (status === undefined || (status !== 'READY' && status !== 'PARTIAL')) return;
    const timer = setTimeout(() => void loadChunks(), 0);
    return () => clearTimeout(timer);
  }, [status, loadChunks]);

  useEffect(() => {
    if (status === undefined || !isActive(status)) return;
    const timer = setInterval(() => void loadDocument(), POLL_MS);
    return () => clearInterval(timer);
  }, [status, loadDocument]);

  const retry = async (): Promise<void> => {
    try {
      setDocument(await apiJson<DocumentItem>('POST', `/documents/${id}/retry`));
      setNotice(null);
      onChanged();
    } catch {
      setNotice('Không thể thử lại lúc này.');
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await apiJson('DELETE', `/documents/${id}`);
      onDeleted();
    } catch {
      setNotice('Không xóa được tài liệu.');
      setConfirming(false);
    }
  };

  const extraction = document?.extraction ?? null;
  const total = chunks?.total ?? 0;
  const chunkPages = Math.max(1, Math.ceil(total / CHUNK_PAGE_SIZE));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Chi tiết tài liệu"
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/30"
    >
      <div className="flex h-full w-full max-w-xl flex-col bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="min-w-0 truncate text-sm font-semibold">
            {document?.originalFilename ?? 'Tài liệu'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm hover:bg-slate-100"
          >
            Đóng
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
          {state === 'loading' && <p role="status">Đang tải…</p>}
          {state === 'missing' && <p role="alert">Không tìm thấy tài liệu này.</p>}
          {state === 'error' && <p role="alert">Không tải được chi tiết tài liệu.</p>}
          {document !== null && (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-slate-500">Loại</dt>
                <dd>{document.kind}</dd>
                <dt className="text-slate-500">Kích thước</dt>
                <dd>{formatBytes(document.sizeBytes)}</dd>
                <dt className="text-slate-500">Tải lên</dt>
                <dd>{formatDate(document.createdAt)}</dd>
                <dt className="text-slate-500">Trạng thái</dt>
                <dd>
                  <StatusBadge status={document.status} />
                </dd>
              </dl>
              {document.errorCode !== null && (
                <p
                  role="alert"
                  className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
                >
                  {errorText(document.errorCode)}
                </p>
              )}
              {extraction !== null && (
                <p className="mt-3 text-xs text-slate-600">
                  {typeof extraction.pagesTotal === 'number' &&
                    `${String(extraction.pagesTotal)} trang · `}
                  {typeof extraction.coverage === 'number' &&
                    `độ phủ trích xuất ${Math.round(extraction.coverage * 100)}% · `}
                  {typeof extraction.chunkCount === 'number' &&
                    `${String(extraction.chunkCount)} đoạn`}
                </p>
              )}
              {notice !== null && (
                <p role="alert" className="mt-2 text-red-700">
                  {notice}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <a
                  href={`/api/v1/documents/${document.id}/download`}
                  className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                >
                  Tải xuống tệp gốc
                </a>
                {document.status === 'FAILED' && (
                  <button
                    type="button"
                    onClick={() => void retry()}
                    className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                  >
                    Thử lại xử lý
                  </button>
                )}
                {confirming ? (
                  <span className="flex items-center gap-1 rounded-md bg-red-50 px-2 py-1">
                    <span className="text-red-800">Xóa tài liệu này?</span>
                    <button
                      type="button"
                      onClick={() => void remove()}
                      className="rounded px-2 py-0.5 font-medium text-red-800 hover:bg-red-100"
                    >
                      Xóa
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      className="rounded px-2 py-0.5 text-slate-600 hover:bg-slate-200"
                    >
                      Hủy
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    className="rounded-md px-3 py-1.5 text-red-800 hover:bg-red-50"
                  >
                    Xóa
                  </button>
                )}
              </div>

              {(document.status === 'READY' || document.status === 'PARTIAL') && (
                <section className="mt-6" aria-label="Xem trước nội dung đã trích xuất">
                  <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    Nội dung đã trích xuất
                  </h3>
                  {chunks === null ? (
                    <p role="status" className="mt-2 text-slate-500">
                      Đang tải nội dung…
                    </p>
                  ) : chunks.items.length === 0 ? (
                    <p className="mt-2 text-slate-500">Không có nội dung.</p>
                  ) : (
                    <ol className="mt-2 space-y-3">
                      {chunks.items.map((chunk) => (
                        <li key={chunk.index} className="rounded-md border border-slate-200 p-3">
                          <p className="mb-1 text-xs text-slate-500">
                            Đoạn {chunk.index + 1}
                            {chunk.pageStart !== null &&
                              ` · trang ${chunk.pageStart}${
                                chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
                                  ? `–${chunk.pageEnd}`
                                  : ''
                              }`}
                            {chunk.section !== null && ` · ${chunk.section}`}
                          </p>
                          {/* Extracted text is untrusted: rendered as plain text only. */}
                          <p className="break-words whitespace-pre-wrap">{chunk.content}</p>
                        </li>
                      ))}
                    </ol>
                  )}
                  {total > CHUNK_PAGE_SIZE && (
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        Trang {chunkPage}/{chunkPages}
                      </span>
                      <span className="space-x-1">
                        <button
                          type="button"
                          disabled={chunkPage <= 1}
                          onClick={() => setChunkPage(chunkPage - 1)}
                          className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                        >
                          Trước
                        </button>
                        <button
                          type="button"
                          disabled={chunkPage >= chunkPages}
                          onClick={() => setChunkPage(chunkPage + 1)}
                          className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
                        >
                          Sau
                        </button>
                      </span>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
