"""Immutable, provider-neutral contracts for bounded context management.

Trust is a property of the *source*, assigned by trusted application code. No public contract in
this module accepts a caller-supplied trust level or role.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Final

from mm_ai_service.domain.errors import (
    InvalidContextItemError,
    InvalidContextPolicyError,
    InvalidConversationError,
)
from mm_ai_service.domain.llm import ChatMessage, CompletionRequest, MessageRole
from mm_ai_service.domain.prompts import (
    BudgetAccuracy,
    PromptIdentifier,
    PromptInvocation,
    PromptVersion,
)

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")

MAX_HISTORY_TURNS: Final = 64
MAX_TURN_MESSAGE_CHARACTERS: Final = 8192
MAX_HISTORY_CHARACTERS: Final = 65536
MAX_REFERENCE_ITEMS: Final = 8
MAX_REFERENCE_CHARACTERS: Final = 16384
MAX_SAFETY_MARGIN_TOKENS: Final = 4096


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True, slots=True)
class ConversationIdentifier:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not _IDENTIFIER.fullmatch(self.value):
            raise InvalidConversationError()


@dataclass(frozen=True, slots=True)
class ContextIdentifier:
    value: str

    def __post_init__(self) -> None:
        if not isinstance(self.value, str) or not _IDENTIFIER.fullmatch(self.value):
            raise InvalidContextItemError()


class ContextSource(StrEnum):
    TRUSTED_PROMPT = "trusted_prompt"
    CURRENT_REQUEST = "current_request"
    CONVERSATION_HISTORY = "conversation_history"
    REFERENCE_MATERIAL = "reference_material"


class ContextTrust(StrEnum):
    TRUSTED = "trusted"
    UNTRUSTED = "untrusted"


# Trust follows the source and is fixed here. Only server-rendered prompts are trusted; history is
# caller-supplied (and, without an authenticated store, forgeable), so it is untrusted data even
# when it carries the assistant role.
SOURCE_TRUST: Final = MappingProxyType(
    {
        ContextSource.TRUSTED_PROMPT: ContextTrust.TRUSTED,
        ContextSource.CURRENT_REQUEST: ContextTrust.UNTRUSTED,
        ContextSource.CONVERSATION_HISTORY: ContextTrust.UNTRUSTED,
        ContextSource.REFERENCE_MATERIAL: ContextTrust.UNTRUSTED,
    }
)


@dataclass(frozen=True, slots=True)
class ConversationTurn:
    """One complete user message and its assistant reply; a half turn cannot be represented."""

    conversation_identifier: ConversationIdentifier
    sequence: int
    user_content: str
    assistant_content: str

    def __post_init__(self) -> None:
        if not isinstance(self.conversation_identifier, ConversationIdentifier):
            raise InvalidConversationError()
        if not _is_int(self.sequence) or self.sequence < 1:
            raise InvalidConversationError()
        for content in (self.user_content, self.assistant_content):
            if (
                not isinstance(content, str)
                or not content.strip()
                or len(content) > MAX_TURN_MESSAGE_CHARACTERS
            ):
                raise InvalidConversationError()

    @property
    def characters(self) -> int:
        return len(self.user_content) + len(self.assistant_content)


@dataclass(frozen=True, slots=True)
class ConversationSnapshot:
    """Immutable, chronologically ordered history owned by exactly one conversation."""

    conversation_identifier: ConversationIdentifier
    turns: tuple[ConversationTurn, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "turns", tuple(self.turns))
        if not isinstance(self.conversation_identifier, ConversationIdentifier):
            raise InvalidConversationError()
        if len(self.turns) > MAX_HISTORY_TURNS:
            raise InvalidConversationError()
        previous = 0
        total = 0
        for turn in self.turns:
            if (
                not isinstance(turn, ConversationTurn)
                or turn.conversation_identifier != self.conversation_identifier
                or turn.sequence <= previous
            ):
                raise InvalidConversationError()
            previous = turn.sequence
            total += turn.characters
        if total > MAX_HISTORY_CHARACTERS:
            raise InvalidConversationError()

    @classmethod
    def from_messages(
        cls,
        conversation_identifier: ConversationIdentifier,
        messages: Sequence[ChatMessage],
        *,
        first_sequence: int = 1,
    ) -> "ConversationSnapshot":
        """Build a snapshot from role-tagged messages that strictly alternate user/assistant."""
        items = tuple(messages)
        if len(items) % 2 != 0 or not _is_int(first_sequence):
            raise InvalidConversationError()
        turns: list[ConversationTurn] = []
        for index in range(0, len(items), 2):
            user, assistant = items[index], items[index + 1]
            if (
                not isinstance(user, ChatMessage)
                or not isinstance(assistant, ChatMessage)
                or user.role is not MessageRole.USER
                or assistant.role is not MessageRole.ASSISTANT
            ):
                raise InvalidConversationError()
            turns.append(
                ConversationTurn(
                    conversation_identifier,
                    first_sequence + index // 2,
                    user.content,
                    assistant.content,
                )
            )
        return cls(conversation_identifier, tuple(turns))


@dataclass(frozen=True, slots=True)
class ReferenceMaterial:
    """Caller-supplied reference text. It is always untrusted data; it has no trust field."""

    identifier: ContextIdentifier
    content: str

    def __post_init__(self) -> None:
        if not isinstance(self.identifier, ContextIdentifier):
            raise InvalidContextItemError()
        if (
            not isinstance(self.content, str)
            or not self.content.strip()
            or len(self.content) > MAX_REFERENCE_CHARACTERS
        ):
            raise InvalidContextItemError()


@dataclass(frozen=True, slots=True)
class ContextInvocation:
    """Untrusted caller intent for one context-aware request.

    It carries no model, role, trust level, budget, or limit authority.
    """

    prompt: PromptInvocation
    conversation: ConversationSnapshot | None = None
    references: tuple[ReferenceMaterial, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "references", tuple(self.references))
        if not isinstance(self.prompt, PromptInvocation):
            raise InvalidContextItemError()
        if self.conversation is not None and not isinstance(
            self.conversation, ConversationSnapshot
        ):
            raise InvalidConversationError()
        if len(self.references) > MAX_REFERENCE_ITEMS or any(
            not isinstance(item, ReferenceMaterial) for item in self.references
        ):
            raise InvalidContextItemError()
        identifiers = [item.identifier.value for item in self.references]
        if len(set(identifiers)) != len(identifiers):
            raise InvalidContextItemError()


@dataclass(frozen=True, slots=True)
class ContextSelectionPolicy:
    """Explicit, documented optional-context policy (never applies to mandatory content)."""

    safety_margin_tokens: int = 128
    max_history_turns: int = 16
    max_reference_items: int = 4

    def __post_init__(self) -> None:
        if (
            not _is_int(self.safety_margin_tokens)
            or not 0 <= self.safety_margin_tokens <= MAX_SAFETY_MARGIN_TOKENS
            or not _is_int(self.max_history_turns)
            or not 0 <= self.max_history_turns <= MAX_HISTORY_TURNS
            or not _is_int(self.max_reference_items)
            or not 0 <= self.max_reference_items <= MAX_REFERENCE_ITEMS
        ):
            raise InvalidContextPolicyError()


@dataclass(frozen=True, slots=True)
class ContextItem:
    """One assembled message with explicit provenance. Built only by trusted application code."""

    identifier: ContextIdentifier
    source: ContextSource
    trust: ContextTrust
    role: MessageRole
    content: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.identifier, ContextIdentifier)
            or not isinstance(self.source, ContextSource)
            or not isinstance(self.trust, ContextTrust)
            or not isinstance(self.role, MessageRole)
            or self.trust is not SOURCE_TRUST[self.source]
            or self.role is MessageRole.TOOL
            or (self.role is MessageRole.SYSTEM and self.source is not ContextSource.TRUSTED_PROMPT)
            or not isinstance(self.content, str)
            or not self.content.strip()
        ):
            raise InvalidContextItemError()

    def to_message(self) -> ChatMessage:
        return ChatMessage(self.role, self.content)


class ExclusionReason(StrEnum):
    TURN_LIMIT = "turn_limit"
    ITEM_LIMIT = "item_limit"
    TOKEN_BUDGET = "token_budget"


@dataclass(frozen=True, slots=True)
class ExcludedContext:
    identifier: ContextIdentifier
    source: ContextSource
    reason: ExclusionReason
    estimated_tokens: int

    def __post_init__(self) -> None:
        if (
            not isinstance(self.identifier, ContextIdentifier)
            or not isinstance(self.source, ContextSource)
            or not isinstance(self.reason, ExclusionReason)
            or not _is_int(self.estimated_tokens)
            or self.estimated_tokens < 0
        ):
            raise InvalidContextItemError()


@dataclass(frozen=True, slots=True)
class ContextSelectionResult:
    """Which optional units were kept or dropped, and why. Mandatory items are never listed here."""

    included: tuple[ContextIdentifier, ...] = ()
    excluded: tuple[ExcludedContext, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "included", tuple(self.included))
        object.__setattr__(self, "excluded", tuple(self.excluded))
        names = [item.value for item in self.included] + [
            item.identifier.value for item in self.excluded
        ]
        if len(set(names)) != len(names):
            raise InvalidContextItemError()


@dataclass(frozen=True, slots=True)
class ContextBudget:
    """Token accounting for one assembled request; every field is non-negative and consistent."""

    effective_context_tokens: int
    output_tokens: int
    safety_margin_tokens: int
    mandatory_tokens: int
    history_tokens: int
    reference_tokens: int
    accuracy: BudgetAccuracy

    def __post_init__(self) -> None:
        values = (
            self.effective_context_tokens,
            self.output_tokens,
            self.safety_margin_tokens,
            self.mandatory_tokens,
            self.history_tokens,
            self.reference_tokens,
        )
        if (
            any(not _is_int(value) or value < 0 for value in values)
            or not isinstance(self.accuracy, BudgetAccuracy)
            or self.effective_context_tokens < 1
            or self.committed_tokens > self.effective_context_tokens
        ):
            raise InvalidContextPolicyError()

    @property
    def prompt_tokens(self) -> int:
        return self.mandatory_tokens + self.history_tokens + self.reference_tokens

    @property
    def committed_tokens(self) -> int:
        return self.prompt_tokens + self.output_tokens + self.safety_margin_tokens

    @property
    def remaining_tokens(self) -> int:
        return self.effective_context_tokens - self.committed_tokens


@dataclass(frozen=True, slots=True)
class ContextExecutionMetadata:
    """Bounded, content-free measurements; safe to log."""

    prompt_identifier: PromptIdentifier
    prompt_version: PromptVersion
    profile_identifier: PromptIdentifier
    item_count: int
    history_turns_included: int
    history_turns_excluded: int
    references_included: int
    references_excluded: int
    preparation_duration_ms: float

    def __post_init__(self) -> None:
        counts = (
            self.item_count,
            self.history_turns_included,
            self.history_turns_excluded,
            self.references_included,
            self.references_excluded,
        )
        if (
            any(not _is_int(value) or value < 0 for value in counts)
            or not isinstance(self.preparation_duration_ms, float)
            or self.preparation_duration_ms < 0
        ):
            raise InvalidContextPolicyError()


@dataclass(frozen=True, slots=True)
class ContextAssemblyResult:
    """Inspection-only outcome. The service never executes a caller-constructed instance."""

    items: tuple[ContextItem, ...]
    request: CompletionRequest
    selection: ContextSelectionResult
    budget: ContextBudget
    metadata: ContextExecutionMetadata
    messages: tuple[ChatMessage, ...] = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "items", tuple(self.items))
        names = [item.identifier.value for item in self.items]
        if (
            not self.items
            or len(set(names)) != len(names)
            or any(not isinstance(item, ContextItem) for item in self.items)
        ):
            raise InvalidContextItemError()
        object.__setattr__(self, "messages", tuple(item.to_message() for item in self.items))
        if self.messages != self.request.messages:
            raise InvalidContextItemError()
