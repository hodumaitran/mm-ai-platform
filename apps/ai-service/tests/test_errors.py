import asyncio
import json

from starlette.requests import Request

from mm_ai_service.errors import unhandled_exception_handler


def test_unhandled_error_contract_does_not_disclose_exception_details() -> None:
    request = Request({"type": "http", "method": "GET", "path": "/failure", "headers": []})
    response = asyncio.run(unhandled_exception_handler(request, RuntimeError("private detail")))

    assert response.status_code == 500
    assert json.loads(bytes(response.body)) == {
        "error": "Internal Server Error",
        "path": "/failure",
        "status_code": 500,
    }
    assert b"private detail" not in response.body
