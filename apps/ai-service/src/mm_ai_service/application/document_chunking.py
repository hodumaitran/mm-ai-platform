"""Deterministic, structure-aware chunking with source traceability (no LLM, no randomness)."""

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from mm_ai_service.application.document_text import classify_heading
from mm_ai_service.application.prompts import HeuristicTokenEstimator
from mm_ai_service.domain.documents import (
    Block,
    Chunk,
    DocumentErrorCode,
    DocumentLimits,
    DocumentProcessingError,
)

_SPLIT = re.compile(r"((?<=[.!?…;:])[ \t]+|\n+)")
# A piece that is only a list marker ("1.", "2.1)", "a)", "iv.") belongs with the text after it.
_MARKER = re.compile(r"^(?:\d+(?:\.\d+)*|[A-Za-zđĐ]|[ivxIVX]+)[.)]$")


def estimate_tokens(text: str) -> int:
    """Heuristic estimate (see HeuristicTokenEstimator); never an exact tokenizer count."""
    return HeuristicTokenEstimator.text_tokens(text)


@dataclass(slots=True)
class _Unit:
    text: str
    sep: str  # text between the previous unit and this one in the source ("" for the first)
    start: int
    end: int
    page: int | None
    tokens: int
    is_heading: bool = False
    article: str | None = None


def _pieces(text: str) -> Iterator[tuple[str, str, int]]:
    """Yield (separator-before, piece, start-offset-in-text), merging bare list markers forward."""
    parts = _SPLIT.split(text)
    position = 0
    pending: tuple[str, str, int] | None = None
    index = 0
    separator = ""
    while index < len(parts):
        piece = parts[index]
        if index % 2 == 1:
            separator = piece
            position += len(piece)
            index += 1
            continue
        start = position
        position += len(piece)
        index += 1
        if not piece:
            continue
        if pending is not None:
            joined_sep, joined_text, joined_start = pending
            piece = joined_text + separator + piece
            start = joined_start
            separator = joined_sep
            pending = None
        elif _MARKER.match(piece) and index < len(parts):
            pending = (separator, piece, start)
            continue
        yield separator, piece, start
        separator = ""
    if pending is not None:
        yield pending


def _hard_split(piece: str, max_tokens: int) -> Iterator[str]:
    """Split an over-long piece by words, then by characters, so every part fits `max_tokens`."""
    window = max(1, max_tokens // 4)  # worst case 4 estimated tokens per character
    current: list[str] = []
    tokens = 0
    for word in re.split(r"(?<=\s)", piece):
        word_tokens = estimate_tokens(word)
        if word_tokens > max_tokens:
            if current:
                yield "".join(current)
                current, tokens = [], 0
            for index in range(0, len(word), window):
                yield word[index : index + window]
            continue
        if tokens + word_tokens > max_tokens and current:
            yield "".join(current)
            current, tokens = [], 0
        current.append(word)
        tokens += word_tokens
    if current:
        yield "".join(current)


class _Chunker:
    def __init__(self, limits: DocumentLimits) -> None:
        self._limits = limits
        self._units: list[_Unit] = []
        self._carried = 0  # number of leading units that are overlap from the previous chunk
        self._tokens = 0
        self._index = 0
        self._path: dict[int, str] = {}
        self._start_path: tuple[str | None, str | None] = (None, None)
        self._start_article: str | None = None
        self._articles: list[str] = []

    # -- structure ------------------------------------------------------------------------

    def enter_heading(self, level: int, label: str) -> None:
        self._path = {key: value for key, value in self._path.items() if key < level}
        self._path[level] = label

    def _snapshot(self) -> tuple[str | None, str | None]:
        if not self._path:
            return None, None
        labels = [self._path[key] for key in sorted(self._path)]
        return labels[-1], " > ".join(labels)

    # -- chunk assembly -------------------------------------------------------------------

    def add(self, unit: _Unit) -> Iterator[Chunk]:
        if len(self._units) == self._carried:  # nothing new yet: the chunk starts at this unit
            self._start_path = self._snapshot()
            self._articles = []
        if self._units and self._tokens + unit.tokens > self._limits.chunk_target_tokens:
            yield from self.flush(carry=True)
            self._start_path = self._snapshot()
            self._articles = []
        if unit.article is not None and unit.article not in self._articles:
            self._articles.append(unit.article)
        self._units.append(unit)
        self._tokens += unit.tokens

    def flush(self, *, carry: bool) -> Iterator[Chunk]:
        fresh = self._units[self._carried :]
        if not fresh:
            self._units, self._carried, self._tokens = [], 0, 0
            return
        text = "".join(
            (unit.sep if position else "") + unit.text for position, unit in enumerate(self._units)
        )
        if text.strip():
            if self._index >= self._limits.max_chunks:
                raise DocumentProcessingError(DocumentErrorCode.CONTENT_LIMIT)
            pages = [unit.page for unit in self._units if unit.page is not None]
            heading, section = self._start_path
            yield Chunk(
                index=self._index,
                text=text,
                page_start=min(pages) if pages else None,
                page_end=max(pages) if pages else None,
                heading=heading,
                section=section,
                articles=tuple(self._articles),
                char_start=self._units[0].start,
                char_end=self._units[-1].end,
                estimated_tokens=estimate_tokens(text),
            )
            self._index += 1
        kept: list[_Unit] = []
        total = 0
        if carry:
            for unit in reversed(self._units):
                if unit.is_heading or total + unit.tokens > self._limits.chunk_overlap_tokens:
                    break
                kept.insert(0, unit)
                total += unit.tokens
        self._units, self._carried, self._tokens = kept, len(kept), total
        if kept:
            self._articles = [kept_unit.article for kept_unit in kept if kept_unit.article]

    def starts_new_section(self) -> bool:
        return len(self._units) > self._carried and self._tokens >= self._limits.chunk_min_tokens


def chunk_blocks(blocks: Iterable[Block], limits: DocumentLimits) -> Iterator[Chunk]:
    """Stream chunks from blocks without holding the document in memory.

    Chunks end on paragraph, heading or sentence boundaries; a new article or chapter closes the
    current chunk once it holds a meaningful amount of text (no overlap across sections); overlap is
    made of whole trailing sentences. Output is a pure function of the input and the limits.
    """
    chunker = _Chunker(limits)
    offset = 0
    total_chars = 0
    for block in blocks:
        text = block.text
        total_chars += len(text)
        if total_chars > limits.max_chars:
            raise DocumentProcessingError(DocumentErrorCode.CONTENT_LIMIT)
        block_start = offset
        offset += len(text) + 2
        if not text.strip():
            continue
        article: str | None = None
        if block.kind == "heading":
            classified = classify_heading(text)
            level = classified[0] if classified else (block.level or 1)
            article = classified[2] if classified else None
            if chunker.starts_new_section():
                yield from chunker.flush(carry=False)
            chunker.enter_heading(level, text.strip())
        first = True
        for separator, piece, start in _pieces(text):
            for part in _hard_split(piece, limits.chunk_max_tokens):
                tokens = estimate_tokens(part)
                yield from chunker.add(
                    _Unit(
                        text=part,
                        sep=("\n\n" if first else separator) if True else "",
                        start=block_start + start,
                        end=block_start + start + len(part),
                        page=block.page,
                        tokens=tokens,
                        is_heading=block.kind == "heading",
                        article=article if first else None,
                    )
                )
                first = False
    yield from chunker.flush(carry=False)
