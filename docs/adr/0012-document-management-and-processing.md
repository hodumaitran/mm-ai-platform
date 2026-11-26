# ADR 0012: Document storage, extraction and chunking boundaries

## Status

Accepted for MVP-03.

## Context

The platform needs user-owned documents that later checkpoints can embed, retrieve and cite. This
checkpoint stores and processes them (PDF, DOCX, TXT) and stops before embeddings, vector search, RAG
and OCR. No new infrastructure (queue, object store, cache) is allowed.

## Decision

**Boundaries.** Next.js serves the UI and a same-origin proxy that only forwards an allow-listed set of
routes. NestJS owns authentication, authorization, upload ingestion, private file storage, the document
lifecycle and persistence. The Python AI service owns extraction, normalization and chunking behind a
private endpoint (`POST /v1/documents/process`) that the browser cannot reach. PostgreSQL stores
metadata, jobs and chunks; original files live on the local filesystem outside any served directory.

**Upload.** NestJS streams the multipart body to a temporary file on the same volume while counting
bytes and computing SHA-256 (no buffering), enforces the size limit during upload, checks the extension
and the file signature (never the browser MIME type), then renames the file to a server-generated key
(`ab/<uuid>`) and creates the document and its single job in one transaction. If the insert fails the file
is removed; if the process dies between rename and insert, an orphan sweeper removes the unreferenced
file after a grace period. Filenames are sanitized for display only and never form a path. Limits (size)
are validated at the Next.js proxy, NestJS and the Python service; the PDF page limit and extraction
limits are authoritative in the Python service.

**Processing.** A single `document_processing_jobs` row per document (unique `documentId`) is claimed
atomically with `FOR UPDATE SKIP LOCKED` and a renewable lease; concurrency is bounded (default 1).
NestJS streams the stored file to the Python endpoint and receives NDJSON (`chunk`, then `summary` or
`error`). Chunks are inserted in small batches under a fresh _generation_ (the claim's lease token) and
become visible only when one transaction, guarded by that token, marks the job done, switches
`documents.activeGeneration`, stores the metadata and deletes older generations. No database transaction is
open during extraction. Python runs the actual parsing in a child process with a wall-clock timeout (the
process is killed), cancellation on client disconnect, a memory cap (Windows Job Object, `RLIMIT_AS` on
POSIX) and bounded output; it never loads the whole document's chunks into memory.

**Failure recovery.** Permanent content failures (encrypted, malformed, limits, empty, OCR required) end the
job and are reported with a safe error code. Transient failures (processor busy or down, stream cut)
requeue with backoff up to a bounded number of attempts, then fail. A crashed worker's lease expires and
the job is claimed again; a job whose last attempt expires is marked abandoned. A stale worker cannot
publish (its token no longer matches) and cannot resurrect a deleted document (foreign keys, guarded
updates). Staging chunks of failed, stale or abandoned generations are deleted on the next attempt and by
the sweeper. Deleting a document removes rows first (cascade), cancels in-flight work, then removes the
file; a failed file removal is picked up by the sweeper.

**Security.** All uploads and extracted text are untrusted: no macros or embedded content executed, no
external resources fetched, DOCX archives are bounded (entries, uncompressed size, compression ratio,
path names) and read in memory (never extracted to paths), XML entities are not expanded, extracted text
is rendered as plain text, downloads are attachments with `nosniff` and a sandbox CSP, ownership is
enforced in every query (administrators get no extra access), mutations need the session CSRF token, and
logs carry sizes, codes and durations only. There is no malware scanning: it is not implemented.

**Libraries.** `pypdf` (BSD-3-Clause), `python-docx` (MIT) and its `lxml` dependency (BSD-3-Clause), all
permissive and suitable for proprietary software. PyMuPDF was rejected because it is AGPL/commercial
dual-licensed. `busboy` (MIT) parses multipart in NestJS.

## Consequences

- Processing is single-node: one API process, local filesystem, in-memory cancellation registry.
- Isolation is a child process, not a sandbox: no CPU/disk/network confinement, no syscall filtering.
- Token counts are heuristic estimates (the existing conservative estimator), not tokenizer counts.
- OCR, embeddings and retrieval are deliberately absent; image-only pages are reported, not guessed.
- Chunk text is stored in PostgreSQL and is the source for future embedding and citation (page, section,
  article and character offsets are kept per chunk).
