"""Bounded worker process: extract, chunk and stream results as NDJSON on stdout.

Run as ``python -I -m mm_ai_service.infrastructure.documents.worker '<json spec>'`` by the runner,
which owns the timeout and can kill this process. The spec carries only the document kind, a path to
a private temporary copy and numeric limits. Document text is written to stdout only (never logged);
stderr is discarded by the parent.
"""

import dataclasses
import json
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from mm_ai_service.application.document_chunking import chunk_blocks, estimate_tokens
from mm_ai_service.domain.documents import (
    PROCESSING_VERSION,
    Block,
    Chunk,
    DocumentErrorCode,
    DocumentKind,
    DocumentLimits,
    DocumentOutcome,
    DocumentProcessingError,
    ExtractionStats,
)
from mm_ai_service.infrastructure.documents.extractors import (
    extract_docx,
    extract_pdf,
    extract_txt,
)

Extractor = Callable[[Path, DocumentLimits, ExtractionStats], Iterator[Block]]
EXTRACTORS: dict[DocumentKind, Extractor] = {
    DocumentKind.PDF: extract_pdf,
    DocumentKind.DOCX: extract_docx,
    DocumentKind.TXT: extract_txt,
}
MAX_LISTED_PAGES = 50


def decide_outcome(
    kind: DocumentKind, stats: ExtractionStats, chunk_count: int
) -> tuple[DocumentOutcome, str | None, float | None]:
    """Honest status from what was actually extracted. Empty extraction is never READY."""
    if kind is not DocumentKind.PDF:
        if chunk_count == 0:
            return DocumentOutcome.FAILED, DocumentErrorCode.EMPTY, None
        return DocumentOutcome.READY, None, 1.0
    total = stats.pages_total or 0
    expected = total - stats.pages_blank  # truly blank pages need no text
    if chunk_count == 0 or stats.pages_extracted == 0:
        if stats.pages_image_only > 0:
            return DocumentOutcome.OCR_REQUIRED, DocumentErrorCode.OCR_REQUIRED, 0.0
        if stats.pages_failed:
            return DocumentOutcome.FAILED, DocumentErrorCode.EXTRACTION_FAILED, 0.0
        return DocumentOutcome.FAILED, DocumentErrorCode.EMPTY, 0.0
    coverage = stats.pages_extracted / expected if expected else 1.0
    if stats.pages_extracted < expected:
        return DocumentOutcome.PARTIAL, None, coverage
    return DocumentOutcome.READY, None, coverage


def peak_memory_bytes() -> int | None:
    """Peak resident memory of this process where the platform lets us measure it."""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = Counters()
            counters.cb = ctypes.sizeof(Counters)
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            psapi = ctypes.WinDLL("psapi", use_last_error=True)
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(Counters),
                wintypes.DWORD,
            ]
            if psapi.GetProcessMemoryInfo(
                kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb
            ):
                return int(counters.PeakWorkingSetSize)
            return None
        import resource

        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(usage if sys.platform == "darwin" else usage * 1024)
    except Exception:
        return None


def _apply_memory_limit(limit: int) -> None:
    if sys.platform == "win32":  # enforced by the parent through a Windows Job Object
        return
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except Exception:  # best effort; the parent still enforces the wall-clock timeout
        return


def _emit(out: Any, record: dict[str, Any]) -> None:
    out.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")


def _chunk_record(chunk: Chunk) -> dict[str, Any]:
    return {
        "type": "chunk",
        "index": chunk.index,
        "content": chunk.text,
        "pageStart": chunk.page_start,
        "pageEnd": chunk.page_end,
        "heading": chunk.heading,
        "section": chunk.section,
        "articles": list(chunk.articles),
        "charStart": chunk.char_start,
        "charEnd": chunk.char_end,
        "estimatedTokens": chunk.estimated_tokens,
    }


def process(kind: DocumentKind, path: Path, limits: DocumentLimits, out: Any) -> None:
    stats = ExtractionStats()
    extractor = EXTRACTORS[kind]
    started = time.perf_counter()
    extraction_seconds = 0.0

    def timed() -> Iterator[Block]:
        nonlocal extraction_seconds
        iterator = extractor(path, limits, stats)
        while True:
            before = time.perf_counter()
            try:
                block = next(iterator)
            except StopIteration:
                extraction_seconds += time.perf_counter() - before
                return
            extraction_seconds += time.perf_counter() - before
            yield block

    chunk_count = 0
    total_chars = 0
    total_tokens = 0
    try:
        for chunk in chunk_blocks(timed(), limits):
            _emit(out, _chunk_record(chunk))
            chunk_count += 1
            total_chars += len(chunk.text)
            total_tokens += chunk.estimated_tokens
        outcome, code, coverage = decide_outcome(kind, stats, chunk_count)
    except DocumentProcessingError as error:
        _emit(out, {"type": "error", "code": error.code})
        return
    except MemoryError:
        _emit(out, {"type": "error", "code": DocumentErrorCode.RESOURCE_LIMIT})
        return
    total_seconds = time.perf_counter() - started
    _emit(
        out,
        {
            "type": "summary",
            "status": outcome.value,
            "code": code,
            "metadata": {
                "processingVersion": PROCESSING_VERSION,
                "library": stats.library,
                "pagesTotal": stats.pages_total,
                "pagesExtracted": stats.pages_extracted if kind is DocumentKind.PDF else None,
                "pagesBlank": stats.pages_blank if kind is DocumentKind.PDF else None,
                "pagesImageOnly": stats.pages_image_only if kind is DocumentKind.PDF else None,
                "pagesFailed": len(stats.pages_failed) if kind is DocumentKind.PDF else None,
                "imageOnlyPages": stats.image_only_pages[:MAX_LISTED_PAGES],
                "failedPages": stats.pages_failed[:MAX_LISTED_PAGES],
                "coverage": coverage,
                "chunkCount": chunk_count,
                "totalChars": total_chars,
                "estimatedTokens": total_tokens,
                "chunking": {
                    "version": PROCESSING_VERSION,
                    "targetTokens": limits.chunk_target_tokens,
                    "overlapTokens": limits.chunk_overlap_tokens,
                    "maxTokens": limits.chunk_max_tokens,
                    "tokenCounts": "heuristic estimate, not an exact tokenizer count",
                },
                "extractionMs": round(extraction_seconds * 1000, 1),
                "chunkingMs": round(max(0.0, total_seconds - extraction_seconds) * 1000, 1),
                "peakMemoryBytes": peak_memory_bytes(),
            },
        },
    )


def main(argv: list[str]) -> int:
    spec = json.loads(argv[1])
    limits = DocumentLimits(
        **{
            key: value
            for key, value in spec["limits"].items()
            if key in {field.name for field in dataclasses.fields(DocumentLimits)}
        }
    )
    _apply_memory_limit(limits.max_memory_bytes)
    out = sys.stdout.buffer
    try:
        process(DocumentKind(spec["kind"]), Path(spec["path"]), limits, out)
    except Exception:  # never leak details: the parent maps this to a safe code
        _emit(out, {"type": "error", "code": DocumentErrorCode.FAILED})
    out.flush()
    return 0


__all__ = ["decide_outcome", "estimate_tokens", "main", "process"]

if __name__ == "__main__":
    sys.exit(main(sys.argv))
