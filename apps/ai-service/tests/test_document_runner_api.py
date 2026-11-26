import asyncio
import dataclasses
import sys
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from mm_ai_service.config import Settings
from mm_ai_service.domain.documents import DocumentKind, DocumentLimits
from mm_ai_service.infrastructure.documents.runner import SubprocessDocumentRunner, _WindowsJob
from mm_ai_service.main import create_app
from tests.documents_fixtures import LEGAL_LINES, build_docx, build_pdf, long_text

pytestmark = pytest.mark.filterwarnings("ignore")


def _settings(tmp_path: Path, **overrides: Any) -> Settings:
    return Settings(
        env="test",
        llm_provider="fake",
        document_temp_dir=str(tmp_path),
        _env_file=None,
        **overrides,
    )


async def _collect(
    runner: SubprocessDocumentRunner, kind: DocumentKind, path: Path
) -> list[dict[str, Any]]:
    return [record async for record in runner.run(kind, path)]


def test_real_subprocess_extracts_every_format_and_reports_metadata(tmp_path: Path) -> None:
    runner = SubprocessDocumentRunner(DocumentLimits(), 60)
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(build_pdf([LEGAL_LINES[:6], LEGAL_LINES[6:]]))
    docx = tmp_path / "a.docx"
    docx.write_bytes(build_docx([("Tiêu đề", "Heading 1"), ("Nội dung.", None)], [["a", "b"]]))
    txt = tmp_path / "a.txt"
    txt.write_text(long_text(3), encoding="utf-8")
    for kind, path in ((DocumentKind.PDF, pdf), (DocumentKind.DOCX, docx), (DocumentKind.TXT, txt)):
        records = asyncio.run(_collect(runner, kind, path))
        assert records[-1]["type"] == "summary", records[-1]
        assert records[-1]["status"] == "READY"
        chunks = [r for r in records if r["type"] == "chunk"]
        assert chunks and [c["index"] for c in chunks] == list(range(len(chunks)))
        meta = records[-1]["metadata"]
        assert meta["chunkCount"] == len(chunks) and meta["processingVersion"] == "1"
        assert meta["extractionMs"] >= 0 and meta["chunkingMs"] >= 0
        assert meta["peakMemoryBytes"] is None or meta["peakMemoryBytes"] > 0
    pdf_summary = asyncio.run(_collect(runner, DocumentKind.PDF, pdf))[-1]["metadata"]
    assert (pdf_summary["pagesTotal"], pdf_summary["pagesExtracted"], pdf_summary["coverage"]) == (
        2,
        2,
        1.0,
    )


def test_worker_failures_become_safe_error_records(tmp_path: Path) -> None:
    runner = SubprocessDocumentRunner(DocumentLimits(), 60)
    broken = tmp_path / "x.pdf"
    broken.write_bytes(b"%PDF-1.4\nbroken")
    records = asyncio.run(_collect(runner, DocumentKind.PDF, broken))
    assert records == [{"type": "error", "code": "MALFORMED_DOCUMENT"}]
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(build_pdf(["IMAGE"]))
    last = asyncio.run(_collect(runner, DocumentKind.PDF, scan))[-1]
    assert last["status"] == "OCR_REQUIRED" and last["code"] == "OCR_REQUIRED"


def test_timeout_kills_the_worker_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    started: list[Any] = []
    real = asyncio.create_subprocess_exec

    async def spy(*args: Any, **kwargs: Any) -> Any:
        process = await real(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)
    pdf = tmp_path / "big.pdf"
    pdf.write_bytes(build_pdf([LEGAL_LINES] * 30))
    runner = SubprocessDocumentRunner(DocumentLimits(), 0.05)  # far below interpreter start-up time
    records = asyncio.run(_collect(runner, DocumentKind.PDF, pdf))
    assert records == [{"type": "error", "code": "PROCESSING_TIMEOUT"}]
    assert started[0].returncode is not None  # the process was really terminated


def test_cancellation_terminates_the_worker_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[Any] = []
    real = asyncio.create_subprocess_exec

    async def spy(*args: Any, **kwargs: Any) -> Any:
        process = await real(*args, **kwargs)
        started.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)
    txt = tmp_path / "long.txt"
    txt.write_text(long_text(4000), encoding="utf-8")
    limits = dataclasses.replace(DocumentLimits(), chunk_target_tokens=64, chunk_overlap_tokens=8)

    async def read_one_then_close() -> None:
        events = SubprocessDocumentRunner(limits, 60).run(DocumentKind.TXT, txt)
        async for record in events:
            assert record["type"] == "chunk"
            break
        await events.aclose()  # what happens when the HTTP client disconnects

    asyncio.run(read_one_then_close())
    assert started[0].returncode is not None


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Object memory cap")
def test_windows_job_object_kills_a_memory_hog() -> None:
    import subprocess

    process = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(2); x = bytearray(700 * 1024 * 1024)"]
    )
    assert _WindowsJob(256 * 1024 * 1024).attach(process.pid)
    assert process.wait(timeout=30) != 0


# -- HTTP boundary -------------------------------------------------------------------------------


def _client(tmp_path: Path, runner: Any = None, **overrides: Any) -> TestClient:
    app = create_app(_settings(tmp_path, **overrides), document_runner=runner)
    return TestClient(app)


def _post(client: TestClient, kind: str | None, data: bytes) -> Any:
    headers = {} if kind is None else {"X-Document-Kind": kind}
    return client.post("/v1/documents/process", content=data, headers=headers)


def test_endpoint_streams_ndjson_and_cleans_its_temporary_files(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = _post(client, "txt", long_text(3).encode("utf-8"))
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    lines = [line for line in response.text.splitlines() if line]
    assert lines[0].startswith('{"type":"chunk"') and '"type":"summary"' in lines[-1]
    assert "Đây là một câu" in response.text  # UTF-8 preserved, not escaped
    assert list(tmp_path.iterdir()) == []


def test_endpoint_rejects_bad_kind_signature_size_and_empty_bodies(tmp_path: Path) -> None:
    with _client(tmp_path, document_max_bytes=2048) as client:
        assert _post(client, None, b"x").status_code == 415
        assert _post(client, "exe", b"x").status_code == 415
        assert _post(client, "pdf", b"plain text, not a pdf").status_code == 415
        assert _post(client, "docx", b"%PDF-1.4").status_code == 415
        assert _post(client, "txt", b"abc" + bytes([0]) + b"def").status_code == 415
        assert _post(client, "txt", b"").status_code == 400
        too_big = _post(client, "txt", b"a" * 4096)
        assert too_big.status_code == 413 and "a" * 20 not in too_big.text
    assert list(tmp_path.iterdir()) == []


def test_endpoint_applies_bounded_concurrency_and_releases_the_slot(tmp_path: Path) -> None:
    release = asyncio.Event()

    class SlowRunner:
        async def run(self, kind: DocumentKind, path: Path) -> AsyncGenerator[dict[str, Any]]:
            assert path.exists()
            yield {"type": "chunk", "index": 0, "content": "x"}
            await release.wait()
            yield {"type": "summary", "status": "READY", "code": None, "metadata": {}}

    app = create_app(_settings(tmp_path, document_max_concurrency=1), document_runner=SlowRunner())

    async def scenario() -> tuple[int, int, int]:
        import httpx

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            headers = {"X-Document-Kind": "txt"}
            first_task = asyncio.create_task(
                client.post("/v1/documents/process", content=b"hello", headers=headers)
            )
            await asyncio.sleep(0.3)
            second = await client.post("/v1/documents/process", content=b"hello", headers=headers)
            release.set()
            first = await first_task
            third = await client.post("/v1/documents/process", content=b"hello", headers=headers)
            return first.status_code, second.status_code, third.status_code

    release_loop = asyncio.new_event_loop()
    try:
        assert release_loop.run_until_complete(scenario()) == (200, 429, 200)
    finally:
        release_loop.close()
    assert list(tmp_path.iterdir()) == []
