"""Measure the real extraction pipeline on synthetic PDFs.

Usage: ``python -m tests.benchmark_documents 10 100 500``.

Each run goes through the production path (subprocess runner), so extraction time, chunking time and
the worker's peak memory are what the service would really use. Output is one JSON object per size.
"""

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

from mm_ai_service.domain.documents import DocumentKind, DocumentLimits
from mm_ai_service.infrastructure.documents.runner import SubprocessDocumentRunner
from tests.documents_fixtures import LEGAL_LINES, build_pdf


def make_pdf(pages: int) -> bytes:
    """Dense synthetic pages (about 50 lines, 3,000 characters) with legal headings and clauses."""
    body = []
    for number in range(1, pages + 1):
        lines = [f"Trang {number}. Quy chế quản lý tài liệu nội bộ số {number}/2026."]
        for index in range(1, 49):
            source = LEGAL_LINES[3 + index % 10]
            lines.append(f"{source} ({number}.{index})")
        body.append(lines)
    return build_pdf(body)


async def measure(pages: int, directory: Path) -> dict[str, object]:
    build_started = time.perf_counter()
    data = make_pdf(pages)
    path = directory / f"bench-{pages}.pdf"
    path.write_bytes(data)
    build_seconds = time.perf_counter() - build_started
    runner = SubprocessDocumentRunner(DocumentLimits(), 1800)
    started = time.perf_counter()
    chunks = 0
    summary: dict[str, object] = {}
    async for record in runner.run(DocumentKind.PDF, path):
        if record["type"] == "chunk":
            chunks += 1
        else:
            summary = record
    wall = time.perf_counter() - started
    metadata = summary.get("metadata", {})
    assert isinstance(metadata, dict)
    return {
        "pages": pages,
        "fileBytes": len(data),
        "status": summary.get("status") or summary.get("code"),
        "chunks": chunks,
        "coverage": metadata.get("coverage"),
        "extractionMs": metadata.get("extractionMs"),
        "chunkingMs": metadata.get("chunkingMs"),
        "totalWallMs": round(wall * 1000, 1),
        "peakMemoryMiB": round(metadata["peakMemoryBytes"] / 1048576, 1)
        if metadata.get("peakMemoryBytes")
        else None,
        "totalChars": metadata.get("totalChars"),
        "fixtureBuildSeconds": round(build_seconds, 1),
    }


async def main(sizes: list[int]) -> None:
    with tempfile.TemporaryDirectory(prefix="mm-bench-") as directory:
        for pages in sizes:
            print(json.dumps(await measure(pages, Path(directory)), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main([int(value) for value in sys.argv[1:]] or [10, 100]))
