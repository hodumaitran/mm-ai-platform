import { handleUnauthorized, requestHeaders } from './api.ts';

// Must match DOCUMENT_MAX_BYTES in the web proxy, the API and the AI service (default 50 MiB).
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'txt'] as const;

export type DocumentStatus =
  'PENDING' | 'PROCESSING' | 'READY' | 'PARTIAL' | 'FAILED' | 'OCR_REQUIRED';
export type DocumentKind = 'PDF' | 'DOCX' | 'TXT';

export type DocumentItem = {
  id: string;
  originalFilename: string;
  kind: DocumentKind;
  sizeBytes: number;
  status: DocumentStatus;
  errorCode: string | null;
  extraction: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentChunk = {
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  heading: string | null;
  section: string | null;
  articles: string[];
  estimatedTokens: number;
};

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  PENDING: 'Đang chờ xử lý',
  PROCESSING: 'Đang xử lý',
  READY: 'Sẵn sàng',
  PARTIAL: 'Trích xuất một phần',
  FAILED: 'Lỗi',
  OCR_REQUIRED: 'Cần OCR',
};

export function isActive(status: DocumentStatus): boolean {
  return status === 'PENDING' || status === 'PROCESSING';
}

const ERROR_TEXT: Record<string, string> = {
  ENCRYPTED_DOCUMENT: 'Tài liệu được mã hóa hoặc đặt mật khẩu nên không thể xử lý.',
  MALFORMED_DOCUMENT: 'Tệp bị hỏng hoặc không đúng cấu trúc của định dạng.',
  PAGE_LIMIT_EXCEEDED: 'Tài liệu vượt quá số trang tối đa được phép.',
  CONTENT_LIMIT_EXCEEDED: 'Nội dung tài liệu vượt quá giới hạn xử lý.',
  ARCHIVE_LIMIT_EXCEEDED: 'Cấu trúc nén của tệp DOCX vượt quá giới hạn an toàn.',
  UNSUPPORTED_ENCODING: 'Bảng mã văn bản không được hỗ trợ (chỉ hỗ trợ UTF-8).',
  BINARY_CONTENT: 'Tệp chứa dữ liệu nhị phân, không phải văn bản.',
  EMPTY_DOCUMENT: 'Không trích xuất được nội dung nào từ tài liệu.',
  OCR_REQUIRED: 'Tài liệu là ảnh quét và cần OCR (chưa được hỗ trợ trong phiên bản này).',
  PROCESSING_TIMEOUT: 'Việc xử lý vượt quá thời gian cho phép.',
  RESOURCE_LIMIT_EXCEEDED: 'Tài liệu cần nhiều tài nguyên hơn mức cho phép.',
  PROCESSING_FAILED: 'Xử lý tài liệu không thành công.',
  EXTRACTION_FAILED: 'Không trích xuất được văn bản từ các trang của tài liệu.',
  FILE_MISSING: 'Không tìm thấy tệp gốc trên máy chủ.',
  FILE_TOO_LARGE: 'Tệp vượt quá kích thước tối đa được phép.',
  PROCESSOR_UNAVAILABLE: 'Dịch vụ xử lý tài liệu tạm thời không khả dụng. Hãy thử lại sau.',
  PROCESSING_ABANDONED: 'Việc xử lý bị gián đoạn nhiều lần. Hãy thử lại.',
};

export function errorText(code: string | null): string {
  return code === null ? '' : (ERROR_TEXT[code] ?? 'Xử lý tài liệu không thành công.');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Fast client-side check; the server (proxy, API, AI service) re-validates everything. */
export function validateFile(file: { name: string; size: number }): string | null {
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : '';
  if (!ACCEPTED_EXTENSIONS.some((accepted) => accepted === extension)) {
    return 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.';
  }
  if (file.size === 0) return 'Tệp rỗng.';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Tệp vượt quá ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  }
  return null;
}

export function uploadErrorText(status: number, code: string | undefined): string {
  if (status === 413) return `Tệp vượt quá ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  if (status === 415 && code === 'CONTENT_MISMATCH') {
    return 'Nội dung tệp không khớp với phần mở rộng của nó.';
  }
  if (status === 415) return 'Chỉ hỗ trợ tệp PDF, DOCX và TXT.';
  if (status === 400 && code === 'EMPTY_FILE') return 'Tệp rỗng.';
  if (status === 400) return 'Tệp tải lên không hợp lệ.';
  if (status === 403) return 'Phiên làm việc không hợp lệ. Hãy tải lại trang.';
  return 'Không tải lên được tệp. Vui lòng thử lại.';
}

export type UploadResult =
  { ok: true; document: DocumentItem } | { ok: false; status: number; message: string };

/** Upload with real progress (XMLHttpRequest); the session cookie and CSRF token go with it. */
export function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v1/documents');
    request.withCredentials = true;
    request.setRequestHeader('X-CSRF-Token', requestHeaders('POST', false)['X-CSRF-Token'] ?? '');
    request.upload.onprogress = (event): void => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    request.onerror = (): void =>
      resolve({ ok: false, status: 0, message: uploadErrorText(0, undefined) });
    request.onabort = (): void => resolve({ ok: false, status: 0, message: 'Đã hủy tải lên.' });
    request.onload = (): void => {
      if (request.status === 401) handleUnauthorized();
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = null;
      }
      if (request.status === 201 && typeof body === 'object' && body !== null) {
        resolve({ ok: true, document: body as DocumentItem });
        return;
      }
      const code =
        typeof body === 'object' && body !== null ? (body as { code?: string }).code : undefined;
      resolve({
        ok: false,
        status: request.status,
        message: uploadErrorText(request.status, code),
      });
    };
    signal.addEventListener('abort', () => request.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    request.send(form);
  });
}
