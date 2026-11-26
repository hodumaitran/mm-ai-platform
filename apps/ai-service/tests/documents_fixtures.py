"""Deterministic synthetic documents. No real or confidential content, no external files."""

import io
import zipfile
from collections.abc import Sequence

LEGAL_LINES = [
    "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
    "Chương I",
    "QUY ĐỊNH CHUNG",
    "Điều 1. Phạm vi điều chỉnh",
    "1. Quy chế này quy định về quản lý tài liệu nội bộ.",
    "2. Mức phạt tối đa là 1.500.000 đồng, áp dụng từ ngày 01/07/2026.",
    "Điều 2. Đối tượng áp dụng",
    "a) Cán bộ, nhân viên của công ty.",
    "b) Nhà thầu có ký hợp đồng.",
    "Chương II",
    "TRÁCH NHIỆM",
    "Điều 3. Trách nhiệm của đơn vị",
    "Đơn vị phải bảo đảm tính bảo mật và toàn vẹn của dữ liệu.",
]


def _hex(char: str) -> str:
    return char.encode("utf-16-be").hex()


def build_pdf(pages: Sequence[Sequence[str] | str], *, encrypt_marker: bool = False) -> bytes:
    """A minimal valid PDF whose text is recoverable through a ToUnicode map.

    Each page is a list of lines, ``"IMAGE"`` (an image-only page) or ``[]`` (a blank page).
    Vietnamese text works because extraction relies on the ToUnicode CMap, not on glyphs.
    """
    chars = sorted({c for page in pages if isinstance(page, list) for ln in page for c in ln})
    codes = {c: index + 1 for index, c in enumerate(chars)}
    objects: dict[int, bytes] = {}
    objects[3] = (
        b"<< /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding /Identity-H "
        b"/DescendantFonts [4 0 R] /ToUnicode 5 0 R >>"
    )
    objects[4] = (
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial "
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>"
    )
    blocks = []
    for start in range(0, len(chars), 100):
        group = chars[start : start + 100]
        entries = "\n".join(f"<{codes[c]:04x}> <{_hex(c)}>" for c in group)
        blocks.append(f"{len(group)} beginbfchar\n{entries}\nendbfchar")
    cmap = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n"
        "1 begincodespacerange <0000> <FFFF> endcodespacerange\n"
        + "\n".join(blocks)
        + "\nendcmap CMapName currentdict /CMap defineresource pop end end"
    ).encode("ascii")
    objects[5] = b"<< /Length %d >>\nstream\n" % len(cmap) + cmap + b"\nendstream"
    pixel = bytes([0])
    objects[6] = (
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray "
        b"/BitsPerComponent 8 /Length 1 >>\nstream\n" + pixel + b"\nendstream"
    )
    page_ids: list[int] = []
    number = 7
    for page in pages:
        if page == "IMAGE":
            content = b"q 400 0 0 400 50 300 cm /Im1 Do Q"
            resources = b"/Resources << /XObject << /Im1 6 0 R >> >>"
        else:
            lines = page if isinstance(page, list) else []
            ops = ["BT /F1 11 Tf 14 TL 50 780 Td"]
            for line in lines:
                ops.append("<" + "".join(f"{codes[c]:04x}" for c in line) + "> Tj T*")
            ops.append("ET")
            content = "\n".join(ops).encode("ascii")
            resources = b"/Resources << /Font << /F1 3 0 R >> >>"
        content_id, page_id = number, number + 1
        number += 2
        objects[content_id] = (
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
        )
        objects[page_id] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents %d 0 R " % content_id
            + resources
            + b" >>"
        )
        page_ids.append(page_id)
    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids).encode("ascii")
    objects[2] = b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % len(page_ids)
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets: dict[int, int] = {}
    for object_id in sorted(objects):
        offsets[object_id] = len(out)
        out += b"%d 0 obj\n" % object_id + objects[object_id] + b"\nendobj\n"
    xref = len(out)
    size = max(objects) + 1
    out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
    for object_id in range(1, size):
        out += b"%010d 00000 n \n" % offsets[object_id]
    trailer = b"<< /Size %d /Root 1 0 R" % size
    if encrypt_marker:
        # A trailer /Encrypt entry marks the file as encrypted for the reader (values are junk).
        trailer += (
            b" /Encrypt << /Filter /Standard /V 1 /R 2 /O ("
            + b"0" * 32
            + b") /U ("
            + b"0" * 32
            + b") /P -4 >> /ID [(0000000000000000) (0000000000000000)]"
        )
    out += b"trailer\n" + trailer + b" >>\nstartxref\n%d\n%%%%EOF\n" % xref
    return bytes(out)


def build_docx(
    paragraphs: list[tuple[str, str | None]] | None = None,
    table: list[list[str]] | None = None,
) -> bytes:
    """A DOCX with (text, style) paragraphs followed by an optional table."""
    from docx import Document

    document = Document()
    for text, style in paragraphs or []:
        if style and style.startswith("Heading"):
            document.add_heading(text, level=int(style.split()[-1]))
        else:
            document.add_paragraph(text)
    if table:
        grid = document.add_table(rows=len(table), cols=len(table[0]))
        for r, row in enumerate(table):
            for c, value in enumerate(row):
                grid.cell(r, c).text = value
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def zip_bytes(entries: dict[str, bytes], *, compress: bool = True) -> bytes:
    buffer = io.BytesIO()
    method = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    with zipfile.ZipFile(buffer, "w", method) as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def long_text(
    paragraphs: int, sentence: str = "Đây là một câu thử nghiệm về quản lý tài liệu."
) -> str:
    """Numbered paragraphs of repeated sentences for chunking tests."""
    body = " ".join([sentence] * 12)
    return "\n\n".join(f"{index}. {body}" for index in range(1, paragraphs + 1))
