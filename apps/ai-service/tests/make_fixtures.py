"""Write synthetic fixture documents for cross-service tests.

Usage: ``python -m tests.make_fixtures DIR [PAGES]``.
"""

import sys
from pathlib import Path

from tests.documents_fixtures import (
    LEGAL_LINES,
    build_docx,
    build_pdf,
    long_text,
    zip_bytes,
)


def main(target: Path, pages: int = 0) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / "legal.pdf").write_bytes(
        build_pdf([LEGAL_LINES[:6], LEGAL_LINES[6:9], LEGAL_LINES[9:]])
    )
    (target / "scan.pdf").write_bytes(build_pdf(["IMAGE", "IMAGE"]))
    (target / "mixed.pdf").write_bytes(build_pdf([LEGAL_LINES[:4], "IMAGE", LEGAL_LINES[4:8]]))
    (target / "encrypted.pdf").write_bytes(build_pdf([["x"]], encrypt_marker=True))
    (target / "malformed.pdf").write_bytes(b"%PDF-1.4\nthis is not a real pdf body")
    (target / "legal.txt").write_text("\n".join(LEGAL_LINES), encoding="utf-8")
    (target / "legal.docx").write_bytes(
        build_docx(
            [
                ("Quy chế quản lý tài liệu", "Heading 1"),
                (LEGAL_LINES[3], None),
                (LEGAL_LINES[4], None),
            ],
            [["Hạng mục", "Số tiền"], ["Chi phí", "2.500.000 đồng"]],
        )
    )
    entries = {"[Content_Types].xml": b"<x/>", "word/document.xml": b"<x/>"}
    (target / "bomb.docx").write_bytes(zip_bytes({**entries, "word/media/z.bin": bytes(8_000_000)}))
    if pages:
        body = [[f"Trang {n}.", *LEGAL_LINES[3:9]] for n in range(1, pages + 1)]
        (target / f"pages-{pages}.pdf").write_bytes(build_pdf(body))
    (target / "long.txt").write_text(long_text(40), encoding="utf-8")


if __name__ == "__main__":
    main(Path(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 0)
