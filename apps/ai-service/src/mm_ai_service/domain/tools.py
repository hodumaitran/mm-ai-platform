"""Model-neutral tool contracts.

Everything a model produces (tool name, call identifier, arguments) is untrusted input. These
contracts only validate and freeze that input; they never execute anything. Authorization and
execution policy belong to the application layer and are never derived from model output.
"""

import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from mm_ai_service.domain.errors import (
    InvalidToolArgumentsError,
    InvalidToolCallError,
    InvalidToolDefinitionError,
    ToolResultTooLargeError,
)

TOOL_NAME_PATTERN: Final = re.compile(r"[a-z][a-z0-9_]{0,47}")
CALL_ID_PATTERN: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
PARAMETER_NAME_PATTERN: Final = re.compile(r"[a-z][a-z0-9_]{0,31}")

MAX_ARGUMENT_DEPTH: Final = 3
MAX_ARGUMENT_NODES: Final = 64
MAX_ARGUMENT_COLLECTION_LENGTH: Final = 16
MAX_ARGUMENT_STRING_CHARS: Final = 4096
MAX_ARGUMENT_INTEGER: Final = 2**53
MAX_TOOL_PARAMETERS: Final = 8
MAX_DESCRIPTION_CHARS: Final = 512
MAX_RESULT_CHARS_LIMIT: Final = 16_384

JsonScalar = None | bool | int | float | str


def check_payload_bounds(payload: object) -> None:
    """Bound depth, node count, collection length, strings, integers and non-finite floats.

    Iterative on purpose: a hostile (even cyclic) structure hits the depth or node limit instead of
    exhausting the stack. Only JSON-like types are accepted.
    """
    stack: list[tuple[object, int]] = [(payload, 0)]
    nodes = 0
    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > MAX_ARGUMENT_NODES or depth > MAX_ARGUMENT_DEPTH:
            raise InvalidToolArgumentsError()
        if value is None or isinstance(value, bool):
            continue
        if isinstance(value, int):
            if abs(value) > MAX_ARGUMENT_INTEGER:
                raise InvalidToolArgumentsError()
        elif isinstance(value, float):
            if not math.isfinite(value):
                raise InvalidToolArgumentsError()
        elif isinstance(value, str):
            if len(value) > MAX_ARGUMENT_STRING_CHARS:
                raise InvalidToolArgumentsError()
        elif isinstance(value, Mapping):
            if len(value) > MAX_ARGUMENT_COLLECTION_LENGTH:
                raise InvalidToolArgumentsError()
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > 64:
                    raise InvalidToolArgumentsError()
                stack.append((item, depth + 1))
        elif isinstance(value, (list, tuple)):
            if len(value) > MAX_ARGUMENT_COLLECTION_LENGTH:
                raise InvalidToolArgumentsError()
            stack.extend((item, depth + 1) for item in value)
        else:
            raise InvalidToolArgumentsError()


class ParameterType(StrEnum):
    INTEGER = "integer"
    NUMBER = "number"
    STRING = "string"
    BOOLEAN = "boolean"


@dataclass(frozen=True, slots=True)
class ToolParameter:
    """One flat, strictly typed argument. Nested arguments are intentionally not representable."""

    name: str
    type: ParameterType
    description: str
    required: bool = True
    minimum: float | None = None
    maximum: float | None = None
    max_length: int | None = None
    allowed_values: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        numeric = self.type in (ParameterType.INTEGER, ParameterType.NUMBER)
        bounds = (self.minimum, self.maximum)
        if (
            not isinstance(self.name, str)
            or PARAMETER_NAME_PATTERN.fullmatch(self.name) is None
            or not isinstance(self.type, ParameterType)
            or not isinstance(self.description, str)
            or not self.description.strip()
            or len(self.description) > MAX_DESCRIPTION_CHARS
            or not isinstance(self.required, bool)
            or any(
                bound is not None
                and (
                    isinstance(bound, bool)
                    or not isinstance(bound, (int, float))
                    or not math.isfinite(bound)
                )
                for bound in bounds
            )
            or (not numeric and any(bound is not None for bound in bounds))
            or (
                self.minimum is not None
                and self.maximum is not None
                and self.minimum > self.maximum
            )
        ):
            raise InvalidToolDefinitionError()
        if self.type is ParameterType.STRING:
            if self.max_length is None:
                object.__setattr__(self, "max_length", MAX_ARGUMENT_STRING_CHARS)
            length = self.max_length
            if (
                isinstance(length, bool)
                or not isinstance(length, int)
                or not 1 <= length <= MAX_ARGUMENT_STRING_CHARS
            ):
                raise InvalidToolDefinitionError()
            allowed = self.allowed_values
            if allowed is not None and (
                not isinstance(allowed, tuple)
                or not 1 <= len(allowed) <= MAX_ARGUMENT_COLLECTION_LENGTH
                or any(not isinstance(item, str) or len(item) > length for item in allowed)
                or len(set(allowed)) != len(allowed)
            ):
                raise InvalidToolDefinitionError()
        elif self.max_length is not None or self.allowed_values is not None:
            raise InvalidToolDefinitionError()

    def validate(self, value: object) -> JsonScalar:
        if self.type is ParameterType.BOOLEAN:
            if isinstance(value, bool):
                return value
            raise InvalidToolArgumentsError()
        if self.type is ParameterType.STRING:
            if not isinstance(value, str) or len(value) > (self.max_length or 0):
                raise InvalidToolArgumentsError()
            if self.allowed_values is not None and value not in self.allowed_values:
                raise InvalidToolArgumentsError()
            return value
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise InvalidToolArgumentsError()
        if self.type is ParameterType.INTEGER and not isinstance(value, int):
            raise InvalidToolArgumentsError()
        if not math.isfinite(value):
            raise InvalidToolArgumentsError()
        if (self.minimum is not None and value < self.minimum) or (
            self.maximum is not None and value > self.maximum
        ):
            raise InvalidToolArgumentsError()
        return value


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """Immutable, trusted description of one tool and its strict argument schema."""

    name: str
    description: str
    parameters: tuple[ToolParameter, ...] = ()

    def __post_init__(self) -> None:
        if (
            not isinstance(self.name, str)
            or TOOL_NAME_PATTERN.fullmatch(self.name) is None
            or not isinstance(self.description, str)
            or not self.description.strip()
            or len(self.description) > MAX_DESCRIPTION_CHARS
            or not isinstance(self.parameters, tuple)
            or len(self.parameters) > MAX_TOOL_PARAMETERS
            or any(not isinstance(item, ToolParameter) for item in self.parameters)
            or len({item.name for item in self.parameters}) != len(self.parameters)
        ):
            raise InvalidToolDefinitionError()

    def validate_arguments(self, arguments: Mapping[str, object]) -> Mapping[str, JsonScalar]:
        """Strictly validate untrusted arguments; reject unknown, missing or mistyped fields."""
        declared = {parameter.name: parameter for parameter in self.parameters}
        if any(key not in declared for key in arguments):
            raise InvalidToolArgumentsError()
        validated: dict[str, JsonScalar] = {}
        for name, parameter in declared.items():
            if name in arguments:
                validated[name] = parameter.validate(arguments[name])
            elif parameter.required:
                raise InvalidToolArgumentsError()
        return MappingProxyType(validated)


@dataclass(frozen=True, slots=True, eq=False)
class ToolCall:
    """An untrusted model-produced request to run a named tool.

    Construction bounds and snapshots the arguments, so later mutation of the caller's dictionary
    cannot change what is executed. It carries no authority: the executor decides.
    """

    call_id: str
    tool_name: str
    arguments: Mapping[str, object]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.call_id, str)
            or CALL_ID_PATTERN.fullmatch(self.call_id) is None
            or not isinstance(self.tool_name, str)
            or TOOL_NAME_PATTERN.fullmatch(self.tool_name) is None
            or not isinstance(self.arguments, Mapping)
        ):
            raise InvalidToolCallError()
        check_payload_bounds(self.arguments)
        snapshot = json.loads(json.dumps(dict(self.arguments), allow_nan=False))
        object.__setattr__(self, "arguments", MappingProxyType(snapshot))


class ToolOutcome(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class ToolResultTrust(StrEnum):
    UNTRUSTED = "untrusted"


@dataclass(frozen=True, slots=True)
class ToolResult:
    """Sanitized outcome. ``content`` is untrusted data, never an instruction."""

    call_id: str
    tool_name: str
    outcome: ToolOutcome
    content: str = ""
    error_code: str | None = None
    trust: ToolResultTrust = ToolResultTrust.UNTRUSTED

    def __post_init__(self) -> None:
        succeeded = self.outcome is ToolOutcome.SUCCEEDED
        if (
            not isinstance(self.outcome, ToolOutcome)
            or not isinstance(self.content, str)
            or len(self.content) > MAX_RESULT_CHARS_LIMIT
            or self.trust is not ToolResultTrust.UNTRUSTED
            or (succeeded and self.error_code is not None)
            or (not succeeded and (self.error_code is None or self.content != ""))
        ):
            raise InvalidToolCallError()


@dataclass(frozen=True, slots=True)
class ToolExecutionMetadata:
    """Privacy-safe facts about one execution: no arguments, results or exception text."""

    tool_name: str
    outcome: ToolOutcome
    duration_ms: int
    argument_count: int
    result_chars: int
    error_code: str | None = None


def serialize_result(value: object, limit: int) -> str:
    """Deterministic, bounded JSON text for a handler's return value."""
    try:
        check_payload_bounds(value)
        text = json.dumps(value, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError, InvalidToolArgumentsError):
        raise ToolResultTooLargeError() from None
    if len(text) > limit:
        raise ToolResultTooLargeError()
    return text
