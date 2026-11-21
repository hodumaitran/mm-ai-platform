import math
import re
from dataclasses import dataclass, field
from enum import StrEnum

from mm_ai_service.domain.errors import InvalidCompletionRequestError

MODEL_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
PROVIDER_IDENTIFIER_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
type MetadataValue = str | int | float | bool | None
type Metadata = tuple[tuple[str, MetadataValue], ...]


def _invalid() -> InvalidCompletionRequestError:
    return InvalidCompletionRequestError()


def validate_model_identifier(value: str) -> None:
    if not isinstance(value, str) or not MODEL_IDENTIFIER_PATTERN.fullmatch(value):
        raise _invalid()


def is_valid_provider_identifier(value: str) -> bool:
    return isinstance(value, str) and bool(PROVIDER_IDENTIFIER_PATTERN.fullmatch(value))


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class ThinkingMode(StrEnum):
    DEFAULT = "default"
    ENABLED = "enabled"
    DISABLED = "disabled"


class FinishReason(StrEnum):
    STOP = "stop"
    LENGTH = "length"
    TOOL_CALL = "tool_call"
    CANCELLED = "cancelled"
    OTHER = "other"


@dataclass(frozen=True, slots=True)
class ChatMessage:
    role: MessageRole
    content: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.role, MessageRole)
            or not isinstance(self.content, str)
            or not self.content.strip()
        ):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class ThinkingConfiguration:
    mode: ThinkingMode = ThinkingMode.DEFAULT

    def __post_init__(self) -> None:
        if not isinstance(self.mode, ThinkingMode):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class GenerationOptions:
    temperature: float | None = None
    max_output_tokens: int | None = None
    context_window: int | None = None
    stop_sequences: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "stop_sequences", tuple(self.stop_sequences))
        if self.temperature is not None and (
            isinstance(self.temperature, bool)
            or not isinstance(self.temperature, (int, float))
            or not math.isfinite(self.temperature)
            or not 0 <= self.temperature <= 2
        ):
            raise _invalid()
        if self.max_output_tokens is not None and (
            isinstance(self.max_output_tokens, bool)
            or not isinstance(self.max_output_tokens, int)
            or self.max_output_tokens <= 0
        ):
            raise _invalid()
        if self.context_window is not None and (
            isinstance(self.context_window, bool)
            or not isinstance(self.context_window, int)
            or self.context_window <= 0
        ):
            raise _invalid()
        if (
            self.max_output_tokens is not None
            and self.context_window is not None
            and self.max_output_tokens > self.context_window
        ):
            raise _invalid()
        if len(self.stop_sequences) > 16:
            raise _invalid()
        if any(
            not isinstance(sequence, str) or not sequence or len(sequence) > 256
            for sequence in self.stop_sequences
        ):
            raise _invalid()
        if len(set(self.stop_sequences)) != len(self.stop_sequences):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class TokenUsage:
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None

    def __post_init__(self) -> None:
        values = (self.prompt_tokens, self.completion_tokens, self.total_tokens)
        if any(
            value is not None
            and (isinstance(value, bool) or not isinstance(value, int) or value < 0)
            for value in values
        ):
            raise _invalid()
        if (
            self.prompt_tokens is not None
            and self.completion_tokens is not None
            and self.total_tokens is not None
            and self.prompt_tokens + self.completion_tokens != self.total_tokens
        ):
            raise _invalid()

    @classmethod
    def unavailable(cls) -> "TokenUsage":
        return cls()


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    chat: bool = True
    streaming: bool = False
    thinking: bool = False
    tool_calling: bool = False
    structured_output: bool = False
    max_context_tokens: int | None = None

    def __post_init__(self) -> None:
        if self.max_context_tokens is not None and (
            isinstance(self.max_context_tokens, bool)
            or not isinstance(self.max_context_tokens, int)
            or self.max_context_tokens <= 0
        ):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    model_identifier: str
    messages: tuple[ChatMessage, ...]
    options: GenerationOptions = field(default_factory=GenerationOptions)
    thinking: ThinkingConfiguration = field(default_factory=ThinkingConfiguration)

    def __post_init__(self) -> None:
        validate_model_identifier(self.model_identifier)
        object.__setattr__(self, "messages", tuple(self.messages))
        if not self.messages or any(
            not isinstance(message, ChatMessage) for message in self.messages
        ):
            raise _invalid()
        if not isinstance(self.options, GenerationOptions) or not isinstance(
            self.thinking, ThinkingConfiguration
        ):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class CompletionResponse:
    model_identifier: str
    message: ChatMessage
    finish_reason: FinishReason
    usage: TokenUsage = field(default_factory=TokenUsage.unavailable)
    metadata: Metadata = ()

    def __post_init__(self) -> None:
        validate_model_identifier(self.model_identifier)
        if self.message.role is not MessageRole.ASSISTANT:
            raise _invalid()
        if not isinstance(self.finish_reason, FinishReason) or not isinstance(
            self.usage, TokenUsage
        ):
            raise _invalid()
        if not isinstance(self.metadata, tuple) or len(self.metadata) > 32:
            raise _invalid()
        normalized: list[tuple[str, MetadataValue]] = []
        for entry in self.metadata:
            if not isinstance(entry, tuple) or len(entry) != 2:
                raise _invalid()
            key, value = entry
            if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,63}", key):
                raise _invalid()
            if not isinstance(value, (str, int, float, bool, type(None))):
                raise _invalid()
            if isinstance(value, str) and len(value) > 1024:
                raise _invalid()
            if isinstance(value, float) and not math.isfinite(value):
                raise _invalid()
            normalized.append((key, value))
        keys = [key for key, _value in normalized]
        if len(set(keys)) != len(keys):
            raise _invalid()
        object.__setattr__(self, "metadata", tuple(normalized))


@dataclass(frozen=True, slots=True)
class StreamStarted:
    model_identifier: str

    def __post_init__(self) -> None:
        validate_model_identifier(self.model_identifier)


@dataclass(frozen=True, slots=True)
class ContentDelta:
    content: str

    def __post_init__(self) -> None:
        if not self.content:
            raise _invalid()


@dataclass(frozen=True, slots=True)
class UsageUpdate:
    usage: TokenUsage

    def __post_init__(self) -> None:
        if not isinstance(self.usage, TokenUsage):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class CompletionFinished:
    finish_reason: FinishReason
    usage: TokenUsage = field(default_factory=TokenUsage.unavailable)

    def __post_init__(self) -> None:
        if not isinstance(self.finish_reason, FinishReason) or not isinstance(
            self.usage, TokenUsage
        ):
            raise _invalid()


@dataclass(frozen=True, slots=True)
class StreamError:
    code: str
    message: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.code, str)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]{2,63}", self.code)
            or not isinstance(self.message, str)
            or not self.message.strip()
        ):
            raise _invalid()


type StreamEvent = StreamStarted | ContentDelta | UsageUpdate | CompletionFinished | StreamError
STREAM_EVENT_TYPES = (StreamStarted, ContentDelta, UsageUpdate, CompletionFinished, StreamError)
