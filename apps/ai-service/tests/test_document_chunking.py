import dataclasses
import itertools

import pytest

from mm_ai_service.application.document_chunking import chunk_blocks, estimate_tokens
from mm_ai_service.application.document_text import blocks_from_text
from mm_ai_service.domain.documents import (
    Block,
    DocumentErrorCode,
    DocumentLimits,
    DocumentProcessingError,
)
from tests.documents_fixtures import LEGAL_LINES, long_text

SMALL = DocumentLimits(
    chunk_target_tokens=120, chunk_overlap_tokens=20, chunk_max_tokens=160, chunk_min_tokens=40
)


def _canonical(blocks: list[Block]) -> str:
    return "\n\n".join(block.text for block in blocks)


def test_chunking_is_deterministic_and_covers_every_character() -> None:
    blocks = list(blocks_from_text(long_text(12), page=None))
    first = list(chunk_blocks(blocks, SMALL))
    second = list(chunk_blocks(list(blocks), SMALL))
    assert first == second
    assert [c.index for c in first] == list(range(len(first)))
    canonical = _canonical(blocks)
    for chunk in first:
        assert canonical[chunk.char_start : chunk.char_end] == chunk.text
    covered = [False] * len(canonical)
    for chunk in first:
        for position in range(chunk.char_start, chunk.char_end):
            covered[position] = True
    # Nothing is silently discarded: only the separators between blocks may be uncovered.
    uncovered = "".join(canonical[i] for i, hit in enumerate(covered) if not hit)
    assert uncovered.strip() == ""


def test_chunks_respect_hard_bounds_and_are_never_empty() -> None:
    blocks = list(blocks_from_text(long_text(30), page=None))
    chunks = list(chunk_blocks(blocks, SMALL))
    assert len(chunks) > 5
    for chunk in chunks:
        assert chunk.text.strip()
        assert estimate_tokens(chunk.text) == chunk.estimated_tokens
        assert chunk.estimated_tokens <= SMALL.chunk_max_tokens + SMALL.chunk_overlap_tokens


def test_consecutive_chunks_overlap_by_whole_sentences() -> None:
    limits = DocumentLimits(
        chunk_target_tokens=200, chunk_overlap_tokens=70, chunk_max_tokens=260, chunk_min_tokens=60
    )
    chunks = list(chunk_blocks(list(blocks_from_text(long_text(6), None)), limits))
    overlapping = [(a, b) for a, b in itertools.pairwise(chunks) if b.char_start < a.char_end]
    assert overlapping, "expected overlap between consecutive chunks"
    for previous, current in overlapping:
        shared = previous.text[current.char_start - previous.char_start :]
        assert current.text.startswith(shared)
        assert estimate_tokens(shared) <= limits.chunk_overlap_tokens


def test_legal_structure_and_clause_markers_are_preserved() -> None:
    lines = [
        *LEGAL_LINES,
        *(f"{n}. Khoản số {n} của điều ba nêu rõ nghĩa vụ." for n in range(4, 40)),
    ]
    blocks = [Block(b.text, b.kind, 1, b.level) for b in blocks_from_text("\n".join(lines), 1)]
    chunks = list(chunk_blocks(blocks, SMALL))
    article_chunks = [c for c in chunks if "Điều 1" in c.articles]
    assert (article_chunks and article_chunks[0].text.startswith("Chương I")) or "Điều 1." in (
        article_chunks[0].text
    )
    assert any(c.section and "Chương II > Điều 3" in c.section for c in chunks)
    assert any(c.heading == "Điều 3. Trách nhiệm của đơn vị" for c in chunks)
    joined = "\n".join(c.text for c in chunks)
    for marker in ("1. Quy chế", "2. Mức phạt", "a) Cán bộ", "b) Nhà thầu"):
        assert marker in joined  # list markers stay attached to their text
    assert not any(c.text.rstrip().endswith(("1.", "2.", "a)", "b)")) for c in chunks)
    assert all(c.page_start == 1 and c.page_end == 1 for c in chunks)


def test_new_article_starts_a_new_chunk_once_the_current_one_is_substantial() -> None:
    body = " ".join(["Nội dung điều khoản rất dài và chi tiết."] * 8)
    text = f"Điều 1. Một\n{body}\n\nĐiều 2. Hai\n{body}"
    chunks = list(chunk_blocks(list(blocks_from_text(text, None)), SMALL))
    starts = [c.text.splitlines()[0] for c in chunks]
    assert "Điều 2. Hai" in starts


def test_long_paragraph_and_unbroken_token_are_split_safely() -> None:
    long_word = "x" * 5000
    blocks = [Block("Câu mở đầu. " + long_word + " câu cuối cùng."), Block("ẩ" * 3000)]
    chunks = list(chunk_blocks(blocks, SMALL))
    assert len(chunks) >= 3
    assert all(
        c.estimated_tokens <= SMALL.chunk_max_tokens + SMALL.chunk_overlap_tokens for c in chunks
    )
    assert "".join(c.text for c in chunks).count("x") >= 5000  # overlap may repeat, never drop


def test_pages_are_attributed_from_blocks_and_never_invented() -> None:
    paged = [
        Block("Trang một có nội dung.", "paragraph", 1),
        Block("Trang hai có nội dung.", "paragraph", 2),
    ]
    unpaged = [Block("Không có trang.")]
    chunk = next(iter(chunk_blocks(paged, DocumentLimits())))
    assert (chunk.page_start, chunk.page_end) == (1, 2)
    none = next(iter(chunk_blocks(unpaged, DocumentLimits())))
    assert none.page_start is None and none.page_end is None


def test_content_and_chunk_limits_fail_explicitly_instead_of_truncating() -> None:
    blocks = list(blocks_from_text(long_text(20), None))
    with pytest.raises(DocumentProcessingError) as chars:
        list(chunk_blocks(blocks, DocumentLimits(max_chars=500)))
    assert chars.value.code == DocumentErrorCode.CONTENT_LIMIT
    with pytest.raises(DocumentProcessingError) as count:
        list(chunk_blocks(blocks, dataclasses.replace(SMALL, max_chunks=3)))
    assert count.value.code == DocumentErrorCode.CONTENT_LIMIT
    assert list(chunk_blocks([], SMALL)) == []
    assert list(chunk_blocks([Block("   ")], SMALL)) == []
