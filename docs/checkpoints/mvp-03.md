# MVP-03: Document management and processing

Status: **LOCAL PASS** (local development only, loopback services). Linux and remote CI NOT RUN.
Decision record: [ADR 0012](../adr/0012-document-management-and-processing.md). Baseline: tag `mvp-02`
(`b3e54c7`); nothing was staged, committed, pushed or tagged.

## Architecture

Browser -> Next.js (UI + allow-listed same-origin proxy, streamed uploads) -> NestJS (auth, ownership,
upload ingestion, private storage, lifecycle, persistence) -> Python AI service (private
`POST /v1/documents/process`: extraction, normalization, chunking in a bounded child process) ->
NDJSON back to NestJS -> PostgreSQL (`documents`, `document_chunks`, `document_processing_jobs`).
Originals live under `DOCUMENT_STORAGE_DIR` (default `apps/api/storage`, git-ignored). No queue, cache or
other infrastructure was added; no embeddings, pgvector, OCR, RAG or LLM call in extraction.

## Libraries and licensing

| Library                          | Use                               | License                 |
| -------------------------------- | --------------------------------- | ----------------------- |
| pypdf 7.1.1                      | PDF text, page by page            | BSD-3-Clause            |
| python-docx 1.2.0 (+ lxml 6.1.3) | DOCX paragraphs, headings, tables | MIT (lxml BSD-3-Clause) |
| busboy 1.6.0                     | multipart streaming in NestJS     | MIT                     |

PyMuPDF was evaluated and rejected: AGPL / commercial dual license is unsuitable for proprietary
enterprise software. TXT uses the standard library (strict UTF-8 / UTF-8 BOM).

## Database

Migration `20261126095400_documents` is additive (no `DROP`, no change to MVP-02 tables) and was applied to
`mm_ai` and `mm_ai_test`. Row counts of users/sessions/conversations/messages were identical before and after
(3 / 4 / 2 / 18). `migrate status`: up to date; `migrate diff` against the schema: no drift; `prisma validate`:
valid. Constraints in the database: unique job per document, unique `(documentId, generation, chunkIndex)`,
ordered offsets and page ranges, sha-256 format, positive size, lease consistency, plus foreign keys with
cascade. Chunks carry document id, deterministic index, content, page (only when genuinely known), heading,
section, offsets, estimated tokens, processing version and the publishing generation.

## Upload and storage security

Streaming multipart (no buffering) with size enforced during upload (proxy, API, AI service), extension and
file-signature validation (browser MIME ignored), SHA-256 while streaming, server-generated keys, path and
symlink checks, sanitized display filenames, temp files cleaned (also at start-up), orphan sweeper, files never
served statically. Downloads are attachments (`nosniff`, sandbox CSP, `no-store`). DOCX: entry count,
uncompressed size, compression ratio and member names are bounded; archives are read in memory, XML
entities are not expanded. No macros or embedded content run, no external resources are fetched. There is
**no malware scanner** (not implemented, not claimed).

## Extraction and chunking

PDF: per page with real page numbers; blank, image-only and failed pages are counted; coverage is reported;
encrypted PDFs are rejected; empty extraction is never READY (`OCR_REQUIRED` for image-only, `EMPTY_DOCUMENT`
otherwise); mixed documents are `PARTIAL` with the image-only pages listed. DOCX: headings (styles and legal
patterns), paragraphs and tables in document order, no invented pages. TXT: paragraphs and structure, UTF-8 /
BOM only, other encodings, UTF-16 and binary content rejected explicitly. Normalization is conservative (NFC,
whitespace, control and zero-width characters). Legal structure (Chương / Mục / Điều, Article / Section,
list markers) is detected and carried as heading, section path and article ids.
Chunking is deterministic and streaming: about 512 estimated tokens, 64 overlap (whole sentences), hard
maximum 768, never empty, split on heading, paragraph and sentence boundaries, long paragraphs and
unbroken tokens split safely, explicit failure (not truncation) when content or chunk limits are exceeded.
Offsets refer to the canonical extracted text (blocks joined by a blank line). Token counts are the existing
heuristic estimates, not tokenizer counts.

## Processing lifecycle

States `PENDING`, `PROCESSING`, `READY`, `PARTIAL`, `FAILED`, `OCR_REQUIRED`. Atomic claim
(`FOR UPDATE SKIP LOCKED`) with renewable lease, bounded concurrency, timeout, bounded retries for transient
failures only, stale-lease recovery, abandoned-job failure, staged generations published in one guarded
transaction, deletion during processing cancels the work and nothing is resurrected, no transaction during
extraction. Isolation limits: the worker is a killable child process with a timeout and memory cap (Windows
Job Object, verified by a test that kills a 700 MiB allocator at 256 MiB); there is no CPU, disk, network or
syscall sandbox.

## Document Library (Vietnamese UI)

"Tài liệu" tab in the sidebar: drag-and-drop and file picker, per-file progress (XMLHttpRequest), sequential
upload queue, client-side pre-checks, status badges with polling, search by filename, status and type
filters, pagination, detail panel with metadata, extraction summary, paginated plain-text preview, original
download, retry for failed documents, delete with confirmation, loading/empty/error states, responsive layout.
No "chat with document" control exists.

## Evidence

**Automated** (real PostgreSQL `mm_ai_test`): API e2e `documents.e2e-spec.ts` (22 tests, fake Python service
over real HTTP, isolated temp storage): validated upload and private storage, DOCX/TXT, invalid signature and
extension, empty, oversize while streaming, path-traversal names, auth and CSRF on every operation,
user-to-user and administrator isolation (list, get, chunks, download, retry, delete all 404), safe download,
filters and pagination, OCR/PARTIAL/FAILED, retry (once, no duplicate job or chunks), bounded transient
retries, interrupted stream, concurrency bound, exactly-once claim across two workers, crashed worker
recovery with a stale worker unable to publish, abandoned jobs, delete during processing, delete cleanup,
restart persistence plus the polling worker, orphan/staging/temp sweeping, database invariants.
`documents-real.e2e-spec.ts` (4 tests) runs **real Python extraction** end to end on generated fixtures:
Vietnamese PDF with page numbers and legal articles, determinism (identical chunks and offsets), DOCX tables
and headings, TXT, scanned, mixed, encrypted, malformed and bomb documents.
Python: 478 passed (30 new: normalization, legal headings, chunking determinism/bounds/overlap/limits, TXT,
DOCX, PDF incl. encrypted/image-only/malformed/page limit, subprocess runner, timeout kill, cancellation kill,
Job Object memory cap, endpoint size/signature/busy/cleanup).

**Live browser** (Playwright, real services, `next start`): eight synthetic documents uploaded in one
selection; final states: legal.pdf / legal.docx / legal.txt READY, mixed.pdf PARTIAL, scan.pdf OCR required,
encrypted.pdf, malformed.pdf and bomb.docx FAILED with Vietnamese explanations. Preview showed the Vietnamese
text with page and section labels. The original downloaded byte for byte (4,682 bytes, `%PDF-`, attachment,
nosniff, sandbox CSP, no storage key in any response). Retry of bomb.docx went PENDING -> FAILED again with the
same clear message; delete with confirmation removed the row, job and file (7 rows / 7 jobs / 7 files left).
A second user (An) saw an empty library and received 404 for get, chunks, download, retry and delete of all
seven of the first user's documents (35 probes), who kept all seven. Direct requests: 51 MiB upload -> 413
at the proxy (8 ms, nothing reached the API), `.exe` -> 415 `UNSUPPORTED_FORMAT`, missing CSRF -> 403, the
Python processing route is 404 from the browser origin; no temp files left. Mobile (390 px) layout checked
and a search-field squeeze was fixed.
Chat regression with the real `qwen3.5:35b` while a 1,000-page document was processing: Vietnamese
("4.", 1.3 s) and English ("The capital of France is Paris.", 0.7 s) answers streamed normally.
Screenshots: `.playwright-mcp/mvp03-empty.png`, `mvp03-list.png`, `mvp03-detail.png`, `mvp03-mobile.png`,
`mvp03-mobile-final.png`.

## Performance (synthetic PDFs, about 2,100 characters per page; text-only, so optimistic)

Worker level (production subprocess path; `python -m tests.benchmark_documents 10 100 500 1000`):

| Pages | File    | Extraction | Chunking | Total  | Chunks | Peak worker memory |
| ----- | ------- | ---------- | -------- | ------ | ------ | ------------------ |
| 10    | 86 KiB  | 134 ms     | 16 ms    | 285 ms | 71     | 31.5 MiB           |
| 100   | 856 KiB | 659 ms     | 163 ms   | 955 ms | 701    | 33.9 MiB           |
| 500   | 4.3 MiB | 2.9 s      | 0.8 s    | 3.9 s  | 3,501  | 43.0 MiB           |
| 1,000 | 8.5 MiB | 5.8 s      | 1.6 s    | 7.5 s  | 7,003  | 54.2 MiB           |

Whole stack through the API (upload -> job -> published): 100 pages 0.49 s, 500 pages 4.3 s, 1,000 pages 8.4 s,
coverage 100%. `document_chunks` grew from 176 KiB to 7.9 MiB for 10,645 chunks (about 2.1 million
characters, indexes included). Memory is bounded by page and chunk size, not document size. Real PDFs with
fonts, images and complex layout will be slower; **5,000-page documents were not measured** and are not
claimed. The configured limit (5,000 pages, 50 MiB) is a safety bound, not verified capacity.

## Run

```powershell
pnpm install                                   # also installs and pins the new libraries
.venv\Scripts\python.exe -m pip install -r apps\ai-service\requirements.lock   # pypdf, python-docx, lxml
cd apps\api; pnpm db:migrate                   # applies 20261126095400_documents (non-destructive)
# services as in MVP-02: AI service (uvicorn), API (node dist/main.js), web (pnpm start)
# generate sample fixtures:  cd apps\ai-service; ..\..\.venv\Scripts\python.exe -m tests.make_fixtures <dir> 100
# benchmark:                 ..\..\.venv\Scripts\python.exe -m tests.benchmark_documents 10 100 500 1000
```

Environment variables are listed in `.env.example` (document section). The size limit must match in the web
proxy, the API (`DOCUMENT_MAX_BYTES`) and the AI service (`AI_SERVICE_DOCUMENT_MAX_BYTES`).

## Limitations

- Single API instance and single node: in-memory cancellation registry, local filesystem storage.
- Child-process isolation only (no CPU/disk/network/syscall sandbox); memory cap is OS-specific (Job Object on
  Windows, `RLIMIT_AS` on POSIX, the latter not exercised on this machine).
- No OCR: scanned pages are reported (`OCR_REQUIRED` / `PARTIAL`), never guessed. DOCX headers, footers,
  footnotes and text boxes are not extracted; DOCX has no page numbers.
- No malware scanning. Token counts are estimates.
- A transient processor outage leaves documents `PENDING` (with backoff) for up to the bounded attempts and
  then `FAILED` (retryable).
- The real-Python e2e suite needs the repository virtual environment; where it is absent it is reported as
  skipped (the JavaScript-only CI job). Linux, Windows CI and remote runs were NOT RUN.
- Test uploads from the browser session remain in the development database and `apps/api/storage`.
