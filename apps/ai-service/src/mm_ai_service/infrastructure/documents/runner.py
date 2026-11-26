"""Runs the document worker in a bounded subprocess that the service can really terminate.

Enforced here: wall-clock timeout (the process is killed), cancellation (the process is killed when
the HTTP client disconnects), stdout line size, and a memory cap (POSIX ``RLIMIT_AS`` in the worker,
a Windows Job Object here). Not enforced: CPU time beyond the wall-clock timeout, disk or network
sandboxing, and syscall filtering; the worker is a plain child process of the service user.
"""

import asyncio
import contextlib
import json
import sys
import time
from collections.abc import AsyncGenerator
from dataclasses import asdict
from pathlib import Path
from typing import Any

from mm_ai_service.domain.documents import (
    DocumentErrorCode,
    DocumentKind,
    DocumentLimits,
)

MAX_LINE_BYTES = 8 * 1024 * 1024


class _WindowsJob:
    """Memory-capped Windows Job Object; the worker is killed if it exceeds the limit."""

    def __init__(self, memory_bytes: int) -> None:
        self._handle: Any = None
        self._memory_bytes = memory_bytes

    def attach(self, pid: int) -> bool:
        if sys.platform != "win32":
            return False
        try:
            import ctypes
            from ctypes import wintypes

            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateJobObjectW.restype = wintypes.HANDLE
            kernel.OpenProcess.restype = wintypes.HANDLE
            kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]

            class Basic(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_int64),
                    ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class IoCounters(ctypes.Structure):
                _fields_ = [
                    (name, ctypes.c_uint64)
                    for name in (
                        "ReadOps",
                        "WriteOps",
                        "OtherOps",
                        "ReadBytes",
                        "WriteBytes",
                        "OtherBytes",
                    )
                ]

            class Extended(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", Basic),
                    ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            job = kernel.CreateJobObjectW(None, None)
            if not job:
                return False
            info = Extended()
            # PROCESS_MEMORY (0x100) | KILL_ON_JOB_CLOSE (0x2000)
            info.BasicLimitInformation.LimitFlags = 0x100 | 0x2000
            info.ProcessMemoryLimit = self._memory_bytes
            if not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
                kernel.CloseHandle(job)
                return False
            process = kernel.OpenProcess(0x0100 | 0x0001, False, pid)  # SET_QUOTA | TERMINATE
            if not process:
                kernel.CloseHandle(job)
                return False
            ok = bool(kernel.AssignProcessToJobObject(job, process))
            kernel.CloseHandle(process)
            if not ok:
                kernel.CloseHandle(job)
                return False
            self._handle = job
            return True
        except Exception:
            return False

    def close(self) -> None:
        if self._handle is not None:
            import ctypes

            ctypes.WinDLL("kernel32").CloseHandle(self._handle)
            self._handle = None


class SubprocessDocumentRunner:
    def __init__(self, limits: DocumentLimits, timeout_seconds: float) -> None:
        self._limits = limits
        self._timeout = timeout_seconds

    async def run(self, kind: DocumentKind, path: Path) -> AsyncGenerator[dict[str, Any]]:
        spec = json.dumps({"kind": kind.value, "path": str(path), "limits": asdict(self._limits)})
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-m",
            "mm_ai_service.infrastructure.documents.worker",
            spec,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=str(path.parent),
            limit=MAX_LINE_BYTES,
        )
        job = _WindowsJob(self._limits.max_memory_bytes)
        job.attach(process.pid)
        deadline = time.monotonic() + self._timeout
        terminal = False
        try:
            assert process.stdout is not None
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    yield {"type": "error", "code": DocumentErrorCode.TIMEOUT}
                    terminal = True
                    return
                try:
                    line = await asyncio.wait_for(process.stdout.readline(), timeout=remaining)
                except TimeoutError:
                    yield {"type": "error", "code": DocumentErrorCode.TIMEOUT}
                    terminal = True
                    return
                except (asyncio.LimitOverrunError, ValueError):
                    yield {"type": "error", "code": DocumentErrorCode.FAILED}
                    terminal = True
                    return
                if not line:
                    break
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                yield record
                if record.get("type") in {"summary", "error"}:
                    terminal = True
                    return
            if not terminal:
                # The worker died without a result: memory cap, crash or external kill.
                yield {"type": "error", "code": DocumentErrorCode.RESOURCE_LIMIT}
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(process.wait(), timeout=10)
            job.close()
