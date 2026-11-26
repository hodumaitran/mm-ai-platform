import codecs
from pathlib import Path

import pytest

from mm_ai_service.application.document_chunking import chunk_blocks
from mm_ai_service.application.document_text import (
    blocks_from_text,
    classify_heading,
    normalize_text,
)
from mm_ai_service.domain.documents import (
    Block,
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
from mm_ai_service.infrastructure.documents.worker import decide_outcome
from tests.documents_fixtures import (
    LEGAL_LINES,
    build_docx,
    build_pdf,
    long_text,
    zip_bytes,
)

LIMITS = DocumentLimits()


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def _extract(extractor, path: Path, limits: DocumentLimits = LIMITS):  # type: ignore[no-untyped-def]
    stats = ExtractionStats()
    return list(extractor(path, limits, stats)), stats


def _code(extractor, path: Path, limits: DocumentLimits = LIMITS) -> str:  # type: ignore[no-untyped-def]
    with pytest.raises(DocumentProcessingError) as error:
        _extract(extractor, path, limits)
    return error.value.code


# -- normalization and structure ---------------------------------------------------------------


def test_normalization_is_conservative_and_keeps_vietnamese_and_numbers() -> None:
    raw = "Điều 5.\u00a0 Mức  phạt:\t1.500.000 đồng\r\n\r\n\r\n\r\nNgày 01/07/2026\u200b\ufeff\x00"
    text = normalize_text(raw)
    assert text == "Điều 5. Mức phạt: 1.500.000 đồng\n\nNgày 01/07/2026"
    assert normalize_text("e\u0302\u0301") == "ế"  # NFC composes combining diacritics


def test_legal_headings_are_detected_with_identifiers() -> None:
    assert classify_heading("Điều 12. Quyền và nghĩa vụ")[0:3:2] == (3, "Điều 12")  # type: ignore[index]
    assert classify_heading("Chương II")[0] == 1  # type: ignore[index]
    assert classify_heading("Mục 3. Thủ tục")[0] == 2  # type: ignore[index]
    assert classify_heading("Article 4: Definitions")[2] == "Article 4"  # type: ignore[index]
    assert classify_heading("Điều kiện áp dụng được quy định riêng") is None
    assert classify_heading("Chương trình đào tạo năm nay") is None
    blocks = list(blocks_from_text("\n".join(LEGAL_LINES), None))
    assert [b.text for b in blocks if b.kind == "heading"][:4] == [
        "Chương I",
        "Điều 1. Phạm vi điều chỉnh",
        "Điều 2. Đối tượng áp dụng",
        "Chương II",
    ]


# -- TXT -------------------------------------------------------------------------------------


def test_txt_utf8_and_bom_keep_vietnamese_and_structure(tmp_path: Path) -> None:
    body = "\n".join(LEGAL_LINES).encode("utf-8")
    for name, data in (("a.txt", body), ("b.txt", codecs.BOM_UTF8 + body)):
        blocks, stats = _extract(extract_txt, _write(tmp_path, name, data))
        text = "\n\n".join(b.text for b in blocks)
        assert "Mức phạt tối đa là 1.500.000 đồng, áp dụng từ ngày 01/07/2026." in text
        assert text.startswith("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM")
        assert all(b.page is None for b in blocks)
        assert stats.library == "builtin"


def test_txt_rejects_unsupported_encodings_binary_and_empty(tmp_path: Path) -> None:
    utf16 = codecs.BOM_UTF16_LE + "xin chào".encode("utf-16-le")
    assert _code(extract_txt, _write(tmp_path, "u16.txt", utf16)) == DocumentErrorCode.ENCODING
    latin1 = "Điều kiện".encode()[:-2]  # truncated multi-byte sequence
    assert _code(extract_txt, _write(tmp_path, "l1.txt", latin1)) == DocumentErrorCode.ENCODING
    assert (
        _code(extract_txt, _write(tmp_path, "binary.txt", b"abc\x00def"))
        == DocumentErrorCode.BINARY
    )
    assert _code(extract_txt, _write(tmp_path, "e.txt", b" \n\n ")) == DocumentErrorCode.EMPTY
    small = DocumentLimits(max_bytes=10)
    assert _code(extract_txt, _write(tmp_path, "big.txt", b"x" * 11), small) == "FILE_TOO_LARGE"


# -- DOCX ------------------------------------------------------------------------------------


def test_docx_preserves_order_headings_paragraphs_and_tables(tmp_path: Path) -> None:
    data = build_docx(
        [
            ("Báo cáo quý 3", "Heading 1"),
            ("Điều 1. Phạm vi", None),
            ("Nội dung đoạn đầu tiên.", None),
            ("Kết quả", "Heading 2"),
        ],
        table=[["Hạng mục", "Số tiền"], ["Chi phí", "2.500.000 đồng"]],
    )
    blocks, stats = _extract(extract_docx, _write(tmp_path, "a.docx", data))
    kinds = [(b.kind, b.text) for b in blocks]
    assert kinds[0] == ("heading", "Báo cáo quý 3")
    assert ("heading", "Điều 1. Phạm vi") in kinds
    assert kinds[-1] == ("table", "Hạng mục | Số tiền\nChi phí | 2.500.000 đồng")
    assert [b.text for b in blocks].index("Kết quả") < len(blocks) - 1  # before the table
    assert all(b.page is None for b in blocks)  # page numbers are never fabricated
    assert stats.library == "python-docx"


def test_docx_rejects_malformed_archives_bombs_and_limits(tmp_path: Path) -> None:
    assert (
        _code(extract_docx, _write(tmp_path, "a.docx", b"PK\x03\x04 not really"))
        == "MALFORMED_DOCUMENT"
    )
    missing = zip_bytes({"hello.txt": b"x"})
    assert _code(extract_docx, _write(tmp_path, "b.docx", missing)) == "MALFORMED_DOCUMENT"
    entries = {"[Content_Types].xml": b"<x/>", "word/document.xml": b"<x/>"}
    traversal = zip_bytes({**entries, "../../evil.txt": b"x"})
    assert _code(extract_docx, _write(tmp_path, "c.docx", traversal)) == "MALFORMED_DOCUMENT"
    bomb = zip_bytes({**entries, "word/media/zeros.bin": bytes(8 * 1024 * 1024)})
    assert _code(extract_docx, _write(tmp_path, "d.docx", bomb)) == DocumentErrorCode.ARCHIVE_LIMIT
    many = zip_bytes({**entries, **{f"word/p{i}.xml": b"x" for i in range(20)}})
    tight = DocumentLimits(docx_max_entries=10)
    assert _code(extract_docx, _write(tmp_path, "e.docx", many), tight) == "ARCHIVE_LIMIT_EXCEEDED"
    big = zip_bytes({**entries, "word/media/a.bin": b"\x01\x02\x03\x04" * 400_000}, compress=False)
    small = DocumentLimits(docx_max_uncompressed_bytes=1_000_000)
    assert _code(extract_docx, _write(tmp_path, "f.docx", big), small) == "ARCHIVE_LIMIT_EXCEEDED"
    empty = build_docx([], None)
    assert _code(extract_docx, _write(tmp_path, "g.docx", empty)) == DocumentErrorCode.EMPTY


def test_docx_xml_entity_expansion_is_not_resolved(tmp_path: Path) -> None:
    document = (
        b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;">]>'
        b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        b"<w:body><w:p><w:r><w:t>&b;&b;</w:t></w:r></w:p></w:body></w:document>"
    )
    data = zip_bytes({"[Content_Types].xml": b"<x/>", "word/document.xml": document})
    path = _write(tmp_path, "xxe.docx", data)
    try:
        blocks, _ = _extract(extract_docx, path)
    except DocumentProcessingError:
        return  # rejected outright is acceptable
    assert "AAAAAAAAAA" * 5 not in "".join(b.text for b in blocks)


# -- PDF -------------------------------------------------------------------------------------


def test_pdf_extracts_vietnamese_with_real_page_numbers(tmp_path: Path) -> None:
    pages = [LEGAL_LINES[:6], LEGAL_LINES[6:9], [], LEGAL_LINES[9:]]
    blocks, stats = _extract(extract_pdf, _write(tmp_path, "a.pdf", build_pdf(pages)))
    by_page: dict[int, str] = {}
    for block in blocks:
        assert block.page is not None
        by_page[block.page] = by_page.get(block.page, "") + block.text + "\n"
    assert sorted(by_page) == [1, 2, 4]  # page 3 is blank and no text is attributed to it
    assert "1.500.000 đồng" in by_page[1]
    assert "Điều 2. Đối tượng áp dụng" in by_page[2]
    assert "Điều 3. Trách nhiệm của đơn vị" in by_page[4]
    assert (stats.pages_total, stats.pages_extracted, stats.pages_blank) == (4, 3, 1)
    assert decide_outcome(DocumentKind.PDF, stats, 3)[0] is DocumentOutcome.READY


def test_pdf_image_only_pages_are_reported_not_silently_empty(tmp_path: Path) -> None:
    blocks, stats = _extract(extract_pdf, _write(tmp_path, "s.pdf", build_pdf(["IMAGE", "IMAGE"])))
    assert blocks == []
    assert stats.pages_image_only == 2
    outcome, code, coverage = decide_outcome(DocumentKind.PDF, stats, 0)
    assert (outcome, code, coverage) == (DocumentOutcome.OCR_REQUIRED, "OCR_REQUIRED", 0.0)


def test_pdf_mixed_pages_are_partial_with_accurate_coverage(tmp_path: Path) -> None:
    pdf = build_pdf([LEGAL_LINES[:4], "IMAGE", LEGAL_LINES[4:8], [], "IMAGE"])
    _, stats = _extract(extract_pdf, _write(tmp_path, "m.pdf", pdf))
    assert stats.image_only_pages == [2, 5]
    outcome, code, coverage = decide_outcome(DocumentKind.PDF, stats, 2)
    assert outcome is DocumentOutcome.PARTIAL and code is None
    assert coverage == pytest.approx(2 / 4)  # the blank page is not expected to have text


def test_pdf_blank_only_document_fails_as_empty_not_ready(tmp_path: Path) -> None:
    _, stats = _extract(extract_pdf, _write(tmp_path, "b.pdf", build_pdf([[], []])))
    assert decide_outcome(DocumentKind.PDF, stats, 0)[:2] == (
        DocumentOutcome.FAILED,
        "EMPTY_DOCUMENT",
    )


def test_pdf_errors_are_explicit(tmp_path: Path) -> None:
    good = build_pdf([LEGAL_LINES[:3]])
    assert _code(
        extract_pdf, _write(tmp_path, "e.pdf", build_pdf([["x"]], encrypt_marker=True))
    ) == (DocumentErrorCode.ENCRYPTED)
    assert (
        _code(extract_pdf, _write(tmp_path, "t.pdf", good[: len(good) // 3]))
        == "MALFORMED_DOCUMENT"
    )
    assert _code(extract_pdf, _write(tmp_path, "j.pdf", b"%PDF-1.4\nnot a pdf at all")) == (
        "MALFORMED_DOCUMENT"
    )
    many = build_pdf([["a"]] * 5)
    assert _code(extract_pdf, _write(tmp_path, "p.pdf", many), DocumentLimits(max_pdf_pages=4)) == (
        DocumentErrorCode.PAGE_LIMIT
    )
    assert _code(extract_pdf, _write(tmp_path, "z.pdf", good), DocumentLimits(max_bytes=100)) == (
        "FILE_TOO_LARGE"
    )


# -- cross-format: no fabricated content, deterministic offsets -------------------------------


def test_chunks_trace_back_to_the_extracted_text(tmp_path: Path) -> None:
    pdf = _write(tmp_path, "c.pdf", build_pdf([LEGAL_LINES[:6], LEGAL_LINES[6:]]))
    blocks, _ = _extract(extract_pdf, pdf)
    canonical = "\n\n".join(block.text for block in blocks)
    chunks = list(chunk_blocks(blocks, LIMITS))
    assert chunks
    for chunk in chunks:
        assert canonical[chunk.char_start : chunk.char_end] == chunk.text
    assert chunks[0].page_start == 1 and chunks[-1].page_end == 2
    assert isinstance(long_text(1), str) and Block("x").kind == "paragraph"
