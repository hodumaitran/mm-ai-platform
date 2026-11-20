from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


async def unhandled_exception_handler(request: Request, _exception: Exception) -> JSONResponse:
    """Return a stable response without leaking exception internals."""
    content: dict[str, Any] = {
        "error": "Internal Server Error",
        "path": request.url.path,
        "status_code": 500,
    }
    return JSONResponse(status_code=500, content=content)
