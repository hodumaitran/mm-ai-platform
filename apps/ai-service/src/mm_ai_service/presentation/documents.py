import asyncio
import json
import logging
import shutil
import tempfile
import time
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path
from typing import Any, Protocol

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from mm_ai_service.application.observability import EventLogger
from mm_ai_service.config import Settings
from mm_ai_service.domain.documents import DocumentKind, DocumentLimits
from mm_ai_service.domain.errors import (
    DocumentProcessorBusyError,
    DocumentTooLargeError,
    InvalidRequestError,
    UnsupportedDocumentError,
)

KIND_HEADER = "X-Document-Kind"
_SIGNATURE_WINDOW = 1024


class DocumentRunner(Protocol):
    def run(self, kind: DocumentKind, path: Path) -> AsyncGenerator[dict[str, Any]]: ...


def limits_from_settings(settings: Settings) -> DocumentLimits:
    return DocumentLimits(
        max_bytes=settings.document_max_bytes,
        max_pdf_pages=settings.document_max_pdf_pages,
        max_chars=settings.document_max_extracted_chars,
        max_chunks=settings.document_max_chunks,
        chunk_target_tokens=settings.document_chunk_target_tokens,
        chunk_overlap_tokens=settings.document_chunk_overlap_tokens,
        chunk_max_tokens=settings.document_chunk_max_tokens,
        docx_max_entries=settings.document_docx_max_entries,
        docx_max_uncompressed_bytes=settings.document_docx_max_uncompressed_bytes,
        docx_max_ratio=settings.document_docx_max_compression_ratio,
        max_memory_bytes=settings.document_worker_memory_limit_bytes,
    )


def signature_matches(kind: DocumentKind, head: bytes) -> bool:
    """Cheap content check that does not trust the declared kind or any browser MIME type."""
    if kind is DocumentKind.PDF:
        return b"%PDF-" in head[:_SIGNATURE_WINDOW]
    if kind is DocumentKind.DOCX:
        return head.startswith(b"PK\x03\x04")
    return b"\x00" not in head  # TXT: a NUL byte means binary content


def _line(record: dict[str, Any]) -> bytes:
    return json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


def create_documents_router(
    settings: Settings,
    runner: DocumentRunner,
    logger: EventLogger | None = None,
) -> APIRouter:
    router = APIRouter()
    limits = limits_from_settings(settings)
    slots = asyncio.Semaphore(settings.document_max_concurrency)

    @router.post("/v1/documents/process", tags=["documents"])
    async def process_document(request: Request) -> StreamingResponse:
        """Private endpoint: stream a document body in, stream NDJSON chunks and a summary out."""
        request_id = request.state.request_id
        try:
            kind = DocumentKind(request.headers.get(KIND_HEADER, ""))
        except ValueError:
            raise UnsupportedDocumentError() from None
        declared = request.headers.get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limits.max_bytes):
            raise DocumentTooLargeError()
        if slots.locked():
            raise DocumentProcessorBusyError()
        await slots.acquire()
        directory = Path(tempfile.mkdtemp(prefix="mm-doc-", dir=settings.document_temp_dir))
        try:
            path = directory / f"input.{kind.value}"
            size = 0
            head = b""
            with path.open("wb") as handle:
                async for chunk in request.stream():
                    if len(head) < _SIGNATURE_WINDOW:
                        head += chunk[: _SIGNATURE_WINDOW - len(head)]
                    size += len(chunk)
                    if size > limits.max_bytes:
                        raise DocumentTooLargeError()
                    handle.write(chunk)
            if size == 0:
                raise InvalidRequestError()
            if not signature_matches(kind, head):
                raise UnsupportedDocumentError()
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            slots.release()
            raise

        async def generate() -> AsyncIterator[bytes]:
            started = time.perf_counter()
            outcome = "cancelled"
            events = runner.run(kind, path)
            try:
                async for record in events:
                    if record.get("type") == "summary":
                        outcome = str(record.get("status"))
                    elif record.get("type") == "error":
                        outcome = str(record.get("code"))
                    yield _line(record)
            finally:
                await events.aclose()
                shutil.rmtree(directory, ignore_errors=True)
                slots.release()
                if logger is not None:
                    logger.event(
                        logging.INFO,
                        "document.processed",
                        request_id=request_id,
                        metadata={
                            "kind": kind.value,
                            "bytes": size,
                            "outcome": outcome,
                            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                        },
                    )

        return StreamingResponse(
            generate(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
