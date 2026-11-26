"""Provider-neutral contracts for document extraction and chunking (no framework imports)."""

from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

PROCESSING_VERSION = "1"


class DocumentKind(StrEnum):
    PDF = "pdf"
    DOCX = "docx"
    TXT = "txt"


class DocumentOutcome(StrEnum):
    READY = "READY"
    PARTIAL = "PARTIAL"
    OCR_REQUIRED = "OCR_REQUIRED"
    FAILED = "FAILED"


# Safe, stable error codes. They never contain document content or filesystem paths.
class DocumentErrorCode:
    ENCRYPTED = "ENCRYPTED_DOCUMENT"
    MALFORMED = "MALFORMED_DOCUMENT"
    PAGE_LIMIT = "PAGE_LIMIT_EXCEEDED"
    CONTENT_LIMIT = "CONTENT_LIMIT_EXCEEDED"
    ARCHIVE_LIMIT = "ARCHIVE_LIMIT_EXCEEDED"
    ENCODING = "UNSUPPORTED_ENCODING"
    BINARY = "BINARY_CONTENT"
    EMPTY = "EMPTY_DOCUMENT"
    OCR_REQUIRED = "OCR_REQUIRED"
    EXTRACTION_FAILED = "EXTRACTION_FAILED"
    TIMEOUT = "PROCESSING_TIMEOUT"
    RESOURCE_LIMIT = "RESOURCE_LIMIT_EXCEEDED"
    FAILED = "PROCESSING_FAILED"
    TOO_LARGE = "FILE_TOO_LARGE"


class DocumentProcessingError(Exception):
    """A permanent, content-related failure with a safe public code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class Block:
    """One structural unit of extracted text, in document order."""

    text: str
    kind: Literal["paragraph", "heading", "table"] = "paragraph"
    page: int | None = None
    # Heading depth (1 = top level). Only set for headings.
    level: int | None = None


@dataclass(frozen=True, slots=True)
class Chunk:
    index: int
    text: str
    page_start: int | None
    page_end: int | None
    heading: str | None
    section: str | None
    articles: tuple[str, ...]
    # Offsets into the canonical extracted text: blocks joined by a blank line (two newlines).
    char_start: int
    char_end: int
    estimated_tokens: int


@dataclass(frozen=True, slots=True)
class DocumentLimits:
    """Authoritative processing limits (configured once, validated at the boundary)."""

    max_bytes: int = 50 * 1024 * 1024
    max_pdf_pages: int = 5000
    max_chars: int = 40_000_000
    max_chunks: int = 100_000
    chunk_target_tokens: int = 512
    chunk_overlap_tokens: int = 64
    chunk_max_tokens: int = 768
    chunk_min_tokens: int = 128
    docx_max_entries: int = 5000
    docx_max_uncompressed_bytes: int = 300 * 1024 * 1024
    docx_max_ratio: int = 100
    max_memory_bytes: int = 2 * 1024 * 1024 * 1024


@dataclass(slots=True)
class ExtractionStats:
    """Filled in by an extractor while its block iterator is consumed."""

    library: str = ""
    pages_total: int | None = None
    pages_extracted: int = 0
    pages_blank: int = 0
    pages_image_only: int = 0
    pages_failed: list[int] = field(default_factory=list)
    image_only_pages: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


type BlockStream = Iterator[Block]
