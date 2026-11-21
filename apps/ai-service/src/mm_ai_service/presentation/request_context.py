import re
import secrets
from contextvars import ContextVar, Token

REQUEST_ID_HEADER = "X-Request-ID"
MAX_REQUEST_ID_LENGTH = 64
_SAFE_REQUEST_ID = re.compile(rf"^[A-Za-z0-9._-]{{1,{MAX_REQUEST_ID_LENGTH}}}$")
_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def resolve_request_id(candidate: str | None) -> str:
    """Preserve a safe caller ID; replace absent or unsafe values."""
    if candidate is not None and _SAFE_REQUEST_ID.fullmatch(candidate):
        return candidate
    return secrets.token_hex(16)


def set_request_id(request_id: str) -> Token[str | None]:
    return _request_id.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    _request_id.reset(token)


def current_request_id() -> str | None:
    return _request_id.get()
