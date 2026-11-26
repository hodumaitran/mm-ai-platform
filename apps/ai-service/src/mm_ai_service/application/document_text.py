"""Conservative text normalization and structure detection for extracted documents."""

import re
import unicodedata
from collections.abc import Iterator

from mm_ai_service.domain.documents import Block


def _char_class(*ranges: tuple[int, int]) -> str:
    """Build a regex class from code point ranges (keeps invisible characters out of the source)."""
    return "[" + "".join(f"{chr(low)}-{chr(high)}" for low, high in ranges) + "]"


# Removed because they carry no text: C0/C1 controls (except tab and newline), byte-order marks and
# zero-width characters that PDF/Word extraction sometimes leaves behind.
_CONTROL = re.compile(
    _char_class(
        (0x00, 0x08),
        (0x0B, 0x0C),
        (0x0E, 0x1F),
        (0x7F, 0x9F),
        (0xFEFF, 0xFEFF),
        (0x200B, 0x200D),
        (0x2060, 0x2060),
    )
)
# Horizontal whitespace variants collapsed to a single space (tab, no-break and typographic spaces).
_HORIZONTAL_SPACE = re.compile(
    _char_class(
        (0x20, 0x20),
        (0x09, 0x09),
        (0xA0, 0xA0),
        (0x2000, 0x200A),
        (0x202F, 0x202F),
        (0x205F, 0x205F),
        (0x3000, 0x3000),
    )
    + "+"
)
_LINE_SEPARATORS = re.compile(_char_class((0x2028, 0x2029)))
_BLANK_RUNS = re.compile(r"\n{3,}")

# Legal and document structure keywords (Vietnamese and English). A heading is a short line that
# starts with one of them followed by an identifier: "Điều 5.", "Chương II", "Article 3", "Phần 1".
_LEVEL_1 = r"(?:Phần|PHẦN|Chương|CHƯƠNG|Part|PART|Chapter|CHAPTER)"
_LEVEL_2 = r"(?:Mục|MỤC|Section|SECTION)"
_LEVEL_3 = r"(?:Điều|ĐIỀU|Article|ARTICLE)"
_IDENTIFIER = r"(?:[IVXLCDM]+|\d+[A-Za-z]?)"
_HEADING = re.compile(
    rf"^(?P<l1>{_LEVEL_1})|^(?P<l2>{_LEVEL_2})|^(?P<l3>{_LEVEL_3})",
)
_HEADING_FULL = re.compile(
    rf"^(?:{_LEVEL_1}|{_LEVEL_2}|{_LEVEL_3})\s+{_IDENTIFIER}(?:[.:)]|\s|$)",
)
_IDENTIFIER_PART = re.compile(rf"^(?P<keyword>\S+)\s+(?P<ident>{_IDENTIFIER})")
MAX_HEADING_CHARACTERS = 200


def normalize_text(raw: str) -> str:
    """NFC, unified newlines, no control characters, single spaces; keeps diacritics and numbering.

    It never rewrites, translates or reorders content: only whitespace and invisible characters
    change, so legal numbers, dates, currency and Vietnamese diacritics survive untouched.
    """
    text = unicodedata.normalize("NFC", raw)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _LINE_SEPARATORS.sub("\n", text)
    text = _CONTROL.sub("", text)
    lines = [_HORIZONTAL_SPACE.sub(" ", line).strip() for line in text.split("\n")]
    return _BLANK_RUNS.sub("\n\n", "\n".join(lines)).strip("\n")


def classify_heading(line: str) -> tuple[int, str, str | None] | None:
    """Return (level, label, article-id) for a legal/structural heading line, else None.

    Level 1 = part/chapter, 2 = section, 3 = article. ``article-id`` is e.g. "Điều 5" and only set
    for level 3. The label is the whole line (it often carries the heading title).
    """
    stripped = line.strip()
    if not stripped or len(stripped) > MAX_HEADING_CHARACTERS or not _HEADING_FULL.match(stripped):
        return None
    match = _HEADING.match(stripped)
    part = _IDENTIFIER_PART.match(stripped)
    if match is None or part is None:
        return None
    level = 1 if match.group("l1") else 2 if match.group("l2") else 3
    article = f"{part.group('keyword')} {part.group('ident')}" if level == 3 else None
    return level, stripped, article


def blocks_from_text(text: str, page: int | None) -> Iterator[Block]:
    """Split normalized text into paragraph and heading blocks, preserving order and line breaks."""
    paragraph: list[str] = []

    def flush() -> Iterator[Block]:
        if paragraph:
            yield Block("\n".join(paragraph), "paragraph", page)
            paragraph.clear()

    for line in text.split("\n"):
        if not line:
            yield from flush()
            continue
        heading = classify_heading(line)
        if heading is not None:
            yield from flush()
            yield Block(line, "heading", page, heading[0])
        else:
            paragraph.append(line)
    yield from flush()
