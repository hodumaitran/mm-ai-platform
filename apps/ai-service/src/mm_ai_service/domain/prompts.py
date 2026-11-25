"""Immutable, provider-neutral contracts for trusted prompt management."""

import re
from dataclasses import dataclass, field
from enum import StrEnum

from mm_ai_service.domain.errors import InvalidPromptTemplateError, InvalidPromptVariableError
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionRequest,
    GenerationOptions,
    MessageRole,
    ThinkingConfiguration,
)

_IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_VERSION = re.compile(r"^[1-9][0-9]{0,5}$")
_VARIABLE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PLACEHOLDER_PATTERN = re.compile(r"\{\{([a-z][a-z0-9_]{0,63})\}\}")
type PromptValue = str | int | bool | tuple[str, ...]
type PromptValues = tuple[tuple[str, PromptValue], ...]


def _invalid() -> InvalidPromptTemplateError:
    return InvalidPromptTemplateError()


def _freeze_values(values: PromptValues) -> PromptValues:
    frozen: list[tuple[str, PromptValue]] = []
    for name, value in values:
        if not isinstance(name, str) or not _VARIABLE.fullmatch(name):
            raise _invalid()
        if isinstance(value, list):
            value = tuple(value)
        if not isinstance(value, (str, int, bool, tuple)) or isinstance(value, float):
            raise _invalid()
        if isinstance(value, tuple) and any(not isinstance(item, str) for item in value):
            raise _invalid()
        frozen.append((name, value))
    if len({name for name, _value in frozen}) != len(frozen):
        raise _invalid()
    return tuple(frozen)


@dataclass(frozen=True, slots=True)
class PromptIdentifier:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not _IDENTIFIER.fullmatch(self.value):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class PromptVersion:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not _VERSION.fullmatch(self.value):
            raise _invalid()


class PromptVariableType(StrEnum):
    STRING = "string"
    INTEGER = "integer"
    BOOLEAN = "boolean"
    STRING_COLLECTION = "string_collection"


@dataclass(frozen=True, slots=True)
class PromptVariableDefinition:
    name: str
    value_type: PromptVariableType
    required: bool = True
    default: PromptValue | None = None
    max_length: int | None = None
    max_items: int | None = None
    minimum: int | None = None
    maximum: int | None = None
    trusted: bool = False

    def __post_init__(self) -> None:
        if (
            not isinstance(self.name, str)
            or not _VARIABLE.fullmatch(self.name)
            or not isinstance(self.value_type, PromptVariableType)
            or not isinstance(self.required, bool)
            or not isinstance(self.trusted, bool)
        ):
            raise _invalid()
        if self.required and self.default is not None:
            raise _invalid()
        if not self.required and self.default is None:
            raise _invalid()
        if self.max_length is not None and (
            isinstance(self.max_length, bool)
            or not isinstance(self.max_length, int)
            or self.max_length < 1
        ):
            raise _invalid()
        if self.max_items is not None and (
            isinstance(self.max_items, bool)
            or not isinstance(self.max_items, int)
            or self.max_items < 1
        ):
            raise _invalid()
        if self.minimum is not None and (
            isinstance(self.minimum, bool) or not isinstance(self.minimum, int)
        ):
            raise _invalid()
        if self.maximum is not None and (
            isinstance(self.maximum, bool) or not isinstance(self.maximum, int)
        ):
            raise _invalid()
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise _invalid()
        if self.value_type is not PromptVariableType.STRING and self.max_length is not None:
            raise _invalid()
        if (
            self.value_type is not PromptVariableType.STRING_COLLECTION
            and self.max_items is not None
        ):
            raise _invalid()
        if self.value_type is not PromptVariableType.INTEGER and (
            self.minimum is not None or self.maximum is not None
        ):
            raise _invalid()
        if self.default is not None:
            try:
                self.validate_value(self.default)
            except InvalidPromptVariableError:
                raise _invalid() from None

    def validate_value(self, value: object) -> PromptValue:
        if self.value_type is PromptVariableType.STRING:
            valid = type(value) is str
            if valid and self.max_length is not None and len(value) > self.max_length:  # type: ignore[arg-type]
                valid = False
        elif self.value_type is PromptVariableType.INTEGER:
            valid = type(value) is int
            if valid and self.minimum is not None and value < self.minimum:  # type: ignore[operator]
                valid = False
            if valid and self.maximum is not None and value > self.maximum:  # type: ignore[operator]
                valid = False
        elif self.value_type is PromptVariableType.BOOLEAN:
            valid = type(value) is bool
        else:
            valid = isinstance(value, (tuple, list)) and all(type(item) is str for item in value)
            if valid and self.max_items is not None and len(value) > self.max_items:  # type: ignore[arg-type]
                valid = False
        if not valid:
            raise InvalidPromptVariableError()
        if isinstance(value, list):
            return tuple(value)
        return value  # type: ignore[return-value]


@dataclass(frozen=True, slots=True)
class PromptMessageTemplate:
    role: MessageRole
    template: str

    def __post_init__(self) -> None:
        if self.role not in (MessageRole.SYSTEM, MessageRole.USER, MessageRole.ASSISTANT):
            raise _invalid()
        if (
            not isinstance(self.template, str)
            or not self.template.strip()
            or len(self.template) > 8192
        ):
            raise _invalid()
        remainder = PLACEHOLDER_PATTERN.sub("", self.template)
        if "{{" in remainder or "}}" in remainder:
            raise _invalid()

    @property
    def variables(self) -> tuple[str, ...]:
        return tuple(match.group(1) for match in PLACEHOLDER_PATTERN.finditer(self.template))


@dataclass(frozen=True, slots=True)
class PromptDefinition:
    identifier: PromptIdentifier
    version: PromptVersion
    messages: tuple[PromptMessageTemplate, ...]
    variables: tuple[PromptVariableDefinition, ...] = ()
    max_rendered_characters: int = 16384

    def __post_init__(self) -> None:
        object.__setattr__(self, "messages", tuple(self.messages))
        object.__setattr__(self, "variables", tuple(self.variables))
        if not self.messages or any(
            not isinstance(item, PromptMessageTemplate) for item in self.messages
        ):
            raise _invalid()
        if any(not isinstance(item, PromptVariableDefinition) for item in self.variables):
            raise _invalid()
        if (
            not isinstance(self.max_rendered_characters, int)
            or not 1 <= self.max_rendered_characters <= 65536
        ):
            raise _invalid()
        declared = {item.name: item for item in self.variables}
        if len(declared) != len(self.variables):
            raise _invalid()
        referenced = {name for message in self.messages for name in message.variables}
        if not referenced.issubset(declared):
            raise _invalid()
        for message in self.messages:
            if message.role is not MessageRole.USER and any(
                not declared[name].trusted for name in message.variables
            ):
                raise _invalid()


@dataclass(frozen=True, slots=True)
class PromptPolicy:
    max_user_characters: int = 4096
    max_output_tokens: int = 1024
    max_context_tokens: int = 4096

    def __post_init__(self) -> None:
        values = (self.max_user_characters, self.max_output_tokens, self.max_context_tokens)
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in values
        ):
            raise _invalid()
        if self.max_output_tokens > self.max_context_tokens:
            raise _invalid()


@dataclass(frozen=True, slots=True)
class PromptProfile:
    identifier: PromptIdentifier
    prompt_identifier: PromptIdentifier
    prompt_version: PromptVersion
    trusted_defaults: PromptValues = ()
    policy: PromptPolicy = field(default_factory=PromptPolicy)

    def __post_init__(self) -> None:
        object.__setattr__(self, "trusted_defaults", _freeze_values(self.trusted_defaults))
        if not isinstance(self.policy, PromptPolicy):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class RenderedPrompt:
    identifier: PromptIdentifier
    version: PromptVersion
    messages: tuple[ChatMessage, ...]
    rendered_characters: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "messages", tuple(self.messages))
        if not self.messages or any(
            not isinstance(message, ChatMessage) for message in self.messages
        ):
            raise _invalid()
        if not isinstance(self.rendered_characters, int) or self.rendered_characters < 1:
            raise _invalid()


class BudgetAccuracy(StrEnum):
    """How far a token count can be trusted; only EXACT and UPPER_BOUND are guarantees."""

    EXACT = "exact"
    UPPER_BOUND = "upper_bound"
    ESTIMATE = "estimate"


@dataclass(frozen=True, slots=True)
class PromptBudget:
    prompt_tokens: int
    output_tokens: int
    total_tokens: int
    accuracy: BudgetAccuracy

    @property
    def is_exact(self) -> bool:
        return self.accuracy is BudgetAccuracy.EXACT

    def __post_init__(self) -> None:
        if (
            any(
                isinstance(value, bool) or not isinstance(value, int) or value < 0
                for value in (self.prompt_tokens, self.output_tokens, self.total_tokens)
            )
            or self.prompt_tokens + self.output_tokens != self.total_tokens
            or not isinstance(self.accuracy, BudgetAccuracy)
        ):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class PromptExecutionMetadata:
    prompt_identifier: PromptIdentifier
    prompt_version: PromptVersion
    profile_identifier: PromptIdentifier
    budget: PromptBudget
    render_duration_ms: float

    def __post_init__(self) -> None:
        if not isinstance(self.render_duration_ms, float) or self.render_duration_ms < 0:
            raise _invalid()


@dataclass(frozen=True, slots=True)
class PromptInvocation:
    """Untrusted caller intent: no model, role, or trusted-variable authority."""

    profile_identifier: PromptIdentifier
    user_content: str
    variables: PromptValues = ()
    options: GenerationOptions = field(default_factory=GenerationOptions)
    thinking: ThinkingConfiguration = field(default_factory=ThinkingConfiguration)


@dataclass(frozen=True, slots=True)
class PromptExecution:
    """Inspection-only preparation result; the service never executes a caller-built one."""

    request: CompletionRequest
    rendered: RenderedPrompt
    metadata: PromptExecutionMetadata
    options: GenerationOptions
