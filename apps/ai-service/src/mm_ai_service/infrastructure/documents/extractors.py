"""PDF, DOCX and TXT extraction. Untrusted input: only called inside the bounded worker process.

Nothing here executes document content: no macros, scripts, embedded objects or external
resources are loaded, and archive members are read in memory (never extracted to a path).
"""

import codecs
import zipfile
from collections.abc import Iterator
from pathlib import Path, PurePosixPath

from mm_ai_service.application.document_text import blocks_from_text, normalize_text
from mm_ai_service.domain.documents import (
    Block,
    DocumentErrorCode,
    DocumentLimits,
    DocumentProcessingError,
    ExtractionStats,
)

_UNSUPPORTED_BOMS = (
    codecs.BOM_UTF32_LE,
    codecs.BOM_UTF32_BE,
    codecs.BOM_UTF16_LE,
    codecs.BOM_UTF16_BE,
)
_NO_COMPRESSION_CHECK_BELOW = 1024 * 1024  # tiny parts cannot be a meaningful bomb


def _fail(code: str) -> DocumentProcessingError:
    return DocumentProcessingError(code)


# -- TXT ------------------------------------------------------------------------------------


def extract_txt(path: Path, limits: DocumentLimits, stats: ExtractionStats) -> Iterator[Block]:
    stats.library = "builtin"
    size = path.stat().st_size
    if size > limits.max_bytes:
        raise _fail(DocumentErrorCode.TOO_LARGE)
    raw = path.read_bytes()
    if raw.startswith(_UNSUPPORTED_BOMS):
        raise _fail(DocumentErrorCode.ENCODING)
    if b"\x00" in raw:
        raise _fail(DocumentErrorCode.BINARY)
    try:
        decoded = raw.decode("utf-8-sig", errors="strict")  # UTF-8 and UTF-8 with BOM only
    except UnicodeDecodeError:
        raise _fail(DocumentErrorCode.ENCODING) from None
    del raw
    text = normalize_text(decoded)
    if not text:
        raise _fail(DocumentErrorCode.EMPTY)
    yield from blocks_from_text(text, None)


# -- DOCX -----------------------------------------------------------------------------------


def _check_archive(path: Path, limits: DocumentLimits) -> None:
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError, ValueError):
        raise _fail(DocumentErrorCode.MALFORMED) from None
    with archive:
        entries = archive.infolist()
        if len(entries) > limits.docx_max_entries:
            raise _fail(DocumentErrorCode.ARCHIVE_LIMIT)
        total = 0
        for entry in entries:
            name = PurePosixPath(entry.filename.replace("\\", "/"))
            if name.is_absolute() or ".." in name.parts or entry.filename.startswith(("/", "\\")):
                raise _fail(DocumentErrorCode.MALFORMED)
            if entry.flag_bits & 0x1:
                raise _fail(DocumentErrorCode.ENCRYPTED)
            total += entry.file_size
            if total > limits.docx_max_uncompressed_bytes:
                raise _fail(DocumentErrorCode.ARCHIVE_LIMIT)
            if (
                entry.file_size > _NO_COMPRESSION_CHECK_BELOW
                and entry.compress_size > 0
                and entry.file_size / entry.compress_size > limits.docx_max_ratio
            ):
                raise _fail(DocumentErrorCode.ARCHIVE_LIMIT)
        names = {entry.filename for entry in entries}
        if "[Content_Types].xml" not in names or "word/document.xml" not in names:
            raise _fail(DocumentErrorCode.MALFORMED)
        if any(name.lower().endswith("encryptedpackage") for name in names):
            raise _fail(DocumentErrorCode.ENCRYPTED)


def extract_docx(path: Path, limits: DocumentLimits, stats: ExtractionStats) -> Iterator[Block]:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    stats.library = "python-docx"
    if path.stat().st_size > limits.max_bytes:
        raise _fail(DocumentErrorCode.TOO_LARGE)
    _check_archive(path, limits)
    try:
        document = Document(str(path))
        body = list(document.element.body.iterchildren())
    except Exception:
        raise _fail(DocumentErrorCode.MALFORMED) from None

    produced = False
    for element in body:
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(element, document)
            text = normalize_text(paragraph.text)
            if not text:
                continue
            style = (paragraph.style.name if paragraph.style is not None else "") or ""
            if style == "Title" or style.startswith("Heading"):
                digits = "".join(ch for ch in style if ch.isdigit())
                level = int(digits) if digits else 1
                yield Block(text, "heading", None, level)
                produced = True
            else:
                for block in blocks_from_text(text, None):
                    yield block
                    produced = True
        elif tag == "tbl":
            table = Table(element, document)
            rows: list[str] = []
            for row in table.rows:
                cells: list[str] = []
                seen: set[int] = set()
                for cell in row.cells:
                    if id(cell._tc) in seen:
                        continue
                    seen.add(id(cell._tc))
                    cells.append(normalize_text(cell.text).replace("\n", " "))
                if any(cells):
                    rows.append(" | ".join(cells))
            if rows:
                yield Block("\n".join(rows), "table", None)
                produced = True
    if not produced:
        raise _fail(DocumentErrorCode.EMPTY)


# -- PDF ------------------------------------------------------------------------------------


def _page_has_image(page: object) -> bool:
    """True when the page references an image XObject (cheap check; nothing is decoded)."""
    try:
        resources = page.get("/Resources")  # type: ignore[attr-defined]
        resources = resources.get_object() if resources is not None else None
        xobjects = resources.get("/XObject") if resources is not None else None
        xobjects = xobjects.get_object() if xobjects is not None else None
        if not xobjects:
            return False
        for reference in xobjects.values():
            resource = reference.get_object()
            if resource.get("/Subtype") == "/Image":
                return True
    except Exception:
        return False
    return False


def extract_pdf(path: Path, limits: DocumentLimits, stats: ExtractionStats) -> Iterator[Block]:
    import logging

    import pypdf

    logging.getLogger("pypdf").setLevel(logging.CRITICAL)
    stats.library = f"pypdf {pypdf.__version__}"
    if path.stat().st_size > limits.max_bytes:
        raise _fail(DocumentErrorCode.TOO_LARGE)
    try:
        reader = pypdf.PdfReader(str(path), strict=False)
        encrypted = reader.is_encrypted
    except Exception:
        raise _fail(DocumentErrorCode.MALFORMED) from None
    if encrypted:
        raise _fail(DocumentErrorCode.ENCRYPTED)
    try:
        total = len(reader.pages)
    except Exception:
        raise _fail(DocumentErrorCode.MALFORMED) from None
    if total == 0:
        raise _fail(DocumentErrorCode.MALFORMED)
    if total > limits.max_pdf_pages:
        raise _fail(DocumentErrorCode.PAGE_LIMIT)
    stats.pages_total = total

    for number in range(1, total + 1):  # real PDF page numbers, 1-based
        try:
            page = reader.pages[number - 1]
            raw = page.extract_text() or ""
        except Exception:
            stats.pages_failed.append(number)
            continue
        text = normalize_text(raw)
        if not text:
            if _page_has_image(page):
                stats.pages_image_only += 1
                stats.image_only_pages.append(number)
            else:
                stats.pages_blank += 1
            continue
        stats.pages_extracted += 1
        for block in blocks_from_text(text, number):
            yield Block(block.text, block.kind, number, block.level)
