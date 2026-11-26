"""Prompt resolution, restricted rendering, budget checks, and gateway orchestration."""

import logging
import math
import time
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Protocol

from mm_ai_service.application.deadline import Clock, RequestDeadline
from mm_ai_service.application.gateway import LLMGateway
from mm_ai_service.application.observability import EventLogger
from mm_ai_service.domain.errors import (
    ConfigurationError,
    DuplicatePromptRegistrationError,
    InvalidPromptProfileError,
    InvalidPromptVariableError,
    MissingPromptVariableError,
    PromptBudgetExceededError,
    PromptNotFoundError,
    PromptPolicyViolationError,
    PromptRegistrySealedError,
    PromptVersionNotFoundError,
    UnknownPromptVariableError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionRequest,
    CompletionResponse,
    GenerationOptions,
    MessageRole,
    StreamEvent,
    ThinkingConfiguration,
    validate_model_identifier,
)
from mm_ai_service.domain.prompts import (
    PLACEHOLDER_PATTERN,
    BudgetAccuracy,
    PromptBudget,
    PromptDefinition,
    PromptExecution,
    PromptExecutionMetadata,
    PromptIdentifier,
    PromptInvocation,
    PromptProfile,
    PromptValue,
    PromptVersion,
    RenderedPrompt,
)


class PromptRepository(Protocol):
    """Read-only view used by the service; it offers no mutation capability."""

    @property
    def is_sealed(self) -> bool: ...

    def resolve(
        self, identifier: PromptIdentifier, version: PromptVersion | None = None
    ) -> PromptDefinition: ...

    def resolve_profile(self, identifier: PromptIdentifier) -> PromptProfile: ...


class PromptRegistry:
    """Startup-mutable, then sealed, in-memory store for trusted server prompt assets.

    Lifecycle: ``register``/``register_profile``/``set_default`` are allowed only before
    ``seal()``. ``seal()`` validates cross-references and makes every later mutation fail.
    There is deliberately no runtime administration path.
    """

    def __init__(self) -> None:
        self._definitions: Mapping[tuple[str, str], PromptDefinition] = MappingProxyType({})
        self._defaults: Mapping[str, str] = MappingProxyType({})
        self._profiles: Mapping[str, PromptProfile] = MappingProxyType({})
        self._sealed = False

    @property
    def is_sealed(self) -> bool:
        return self._sealed

    def _require_open(self) -> None:
        if self._sealed:
            raise PromptRegistrySealedError()

    def register(self, definition: PromptDefinition, *, default: bool = False) -> None:
        self._require_open()
        key = (definition.identifier.value, definition.version.value)
        if key in self._definitions:
            raise DuplicatePromptRegistrationError()
        definitions = dict(self._definitions)
        definitions[key] = definition
        defaults = dict(self._defaults)
        if default:
            defaults[definition.identifier.value] = definition.version.value
        self._definitions = MappingProxyType(definitions)
        self._defaults = MappingProxyType(defaults)

    def set_default(self, identifier: PromptIdentifier, version: PromptVersion) -> None:
        self._require_open()
        if (identifier.value, version.value) not in self._definitions:
            if any(key[0] == identifier.value for key in self._definitions):
                raise PromptVersionNotFoundError()
            raise PromptNotFoundError()
        defaults = dict(self._defaults)
        defaults[identifier.value] = version.value
        self._defaults = MappingProxyType(defaults)

    def resolve(
        self, identifier: PromptIdentifier, version: PromptVersion | None = None
    ) -> PromptDefinition:
        chosen = version.value if version is not None else self._defaults.get(identifier.value)
        definition = (
            self._definitions.get((identifier.value, chosen)) if chosen is not None else None
        )
        if definition is not None:
            return definition
        if any(key[0] == identifier.value for key in self._definitions):
            raise PromptVersionNotFoundError()
        raise PromptNotFoundError()

    def register_profile(self, profile: PromptProfile) -> None:
        self._require_open()
        if profile.identifier.value in self._profiles:
            raise DuplicatePromptRegistrationError()
        definition = self.resolve(profile.prompt_identifier, profile.prompt_version)
        variables = {item.name: item for item in definition.variables}
        supplied = {name for name, _value in profile.trusted_defaults}
        for name, value in profile.trusted_defaults:
            variable = variables.get(name)
            if variable is None or not variable.trusted:
                raise InvalidPromptProfileError()
            try:
                variable.validate_value(value)
            except InvalidPromptVariableError:
                raise InvalidPromptProfileError() from None
        for variable in definition.variables:
            if variable.trusted and variable.required and variable.name not in supplied:
                raise InvalidPromptProfileError()
        profiles = dict(self._profiles)
        profiles[profile.identifier.value] = profile
        self._profiles = MappingProxyType(profiles)

    def resolve_profile(self, identifier: PromptIdentifier) -> PromptProfile:
        profile = self._profiles.get(identifier.value)
        if profile is None:
            raise InvalidPromptProfileError()
        return profile

    def seal(self) -> None:
        """Validate the complete asset graph, then freeze the registry. Idempotent."""
        if self._sealed:
            return
        identifiers = {key[0] for key in self._definitions}
        if not identifiers or identifiers != set(self._defaults):
            raise ConfigurationError()
        if any(
            (profile.prompt_identifier.value, profile.prompt_version.value) not in self._definitions
            for profile in self._profiles.values()
        ):
            raise ConfigurationError()
        self._sealed = True


class TokenEstimator(Protocol):
    """Model-neutral budget port. Implementations must state their accuracy honestly."""

    def estimate(self, messages: Sequence[ChatMessage], output_tokens: int) -> PromptBudget: ...


# Per-message framing (role markers/separators) and reply priming. Chat templates differ by
# model; these allowances are deliberately generous but are not derived from a real template.
_MESSAGE_OVERHEAD_TOKENS = 8
_REPLY_PRIMING_TOKENS = 8


class HeuristicTokenEstimator:
    """Character-class estimate. It is NOT exact and NOT a proven upper bound.

    Weights are in half-tokens per code point: ASCII letters/whitespace 0.5, ASCII digits and
    punctuation 1, Latin/Vietnamese and combining marks 1, other BMP scripts (for example CJK)
    1.5, supplementary-plane code points (for example emoji) 4. They are cautious for ordinary
    Vietnamese, English, CJK, and emoji text, but adversarial or unusual input (random
    identifiers, rare scripts, long ZWJ sequences) can exceed them. The provider's reported
    usage remains the only authoritative count.
    """

    def estimate(self, messages: Sequence[ChatMessage], output_tokens: int) -> PromptBudget:
        half_tokens = 0
        for message in messages:
            half_tokens += 2 * _MESSAGE_OVERHEAD_TOKENS
            for character in message.content:
                half_tokens += self._weight(ord(character), character)
        prompt_tokens = math.ceil(half_tokens / 2) + _REPLY_PRIMING_TOKENS
        return PromptBudget(
            prompt_tokens, output_tokens, prompt_tokens + output_tokens, BudgetAccuracy.ESTIMATE
        )

    @classmethod
    def text_tokens(cls, text: str) -> int:
        """Estimated tokens for bare text (no chat framing); an estimate, not a tokenizer count."""
        return math.ceil(sum(cls._weight(ord(character), character) for character in text) / 2)

    @staticmethod
    def _weight(code_point: int, character: str) -> int:
        if code_point < 0x80:
            return 1 if character.isalpha() or character.isspace() else 2
        if code_point < 0x250 or 0x300 <= code_point < 0x370 or 0x1E00 <= code_point < 0x1F00:
            return 2
        if code_point >= 0x10000:
            return 8
        return 3


class Utf8ByteUpperBoundEstimator:
    """Provable upper bound for byte-level BPE or byte-fallback tokenizers only.

    Such a tokenizer never emits more tokens than UTF-8 bytes, so ``bytes`` plus framing
    allowances bounds the prompt. It is very pessimistic (about 1 token per byte), roughly
    halving usable context for Vietnamese. Use when a rejected request is cheaper than an
    overflow. The proof does not extend to tokenizers lacking byte fallback.
    """

    def estimate(self, messages: Sequence[ChatMessage], output_tokens: int) -> PromptBudget:
        prompt_tokens = _REPLY_PRIMING_TOKENS + sum(
            _MESSAGE_OVERHEAD_TOKENS + len(message.content.encode("utf-8")) for message in messages
        )
        return PromptBudget(
            prompt_tokens, output_tokens, prompt_tokens + output_tokens, BudgetAccuracy.UPPER_BOUND
        )


class PromptRenderer:
    """Single-pass renderer: one scan of the original validated template."""

    def render(self, definition: PromptDefinition, values: Mapping[str, object]) -> RenderedPrompt:
        declared = {variable.name: variable for variable in definition.variables}
        if any(name not in declared for name in values):
            raise UnknownPromptVariableError()
        normalized: dict[str, PromptValue] = {}
        for name, variable in declared.items():
            if name in values:
                normalized[name] = variable.validate_value(values[name])
            elif variable.required or variable.default is None:
                raise MissingPromptVariableError()
            else:
                normalized[name] = variable.default
        text = {name: self._text(value) for name, value in normalized.items()}
        limit = definition.max_rendered_characters
        total = 0
        rendered_messages: list[ChatMessage] = []
        for message in definition.messages:
            pieces: list[str] = []
            cursor = 0
            for match in PLACEHOLDER_PATTERN.finditer(message.template):
                pieces.append(message.template[cursor : match.start()])
                pieces.append(text[match.group(1)])
                cursor = match.end()
                total += len(pieces[-2]) + len(pieces[-1])
                if total > limit:
                    raise PromptPolicyViolationError()
            tail = message.template[cursor:]
            pieces.append(tail)
            total += len(tail)
            if total > limit:
                raise PromptPolicyViolationError()
            rendered_messages.append(ChatMessage(message.role, "".join(pieces)))
        return RenderedPrompt(
            definition.identifier, definition.version, tuple(rendered_messages), total
        )

    @staticmethod
    def _text(value: PromptValue) -> str:
        if isinstance(value, tuple):
            return ", ".join(value)
        if isinstance(value, bool):
            return str(value).lower()
        return str(value)


@dataclass(frozen=True, slots=True)
class ResolvedPrompt:
    """Validated trusted prompt parts and effective limits, before any budget check."""

    definition: PromptDefinition
    profile: PromptProfile
    rendered: RenderedPrompt
    user_message: ChatMessage
    options: GenerationOptions
    context_limit: int
    thinking: ThinkingConfiguration

    @property
    def output_tokens(self) -> int:
        return self.options.max_output_tokens or 0


class PromptService:
    """Trusted internal entry point; it cannot create prompts or bypass the LLM gateway.

    The model is a trusted constructor argument, runtime limits come from the gateway, and
    ``complete``/``stream`` re-derive everything from an untrusted ``PromptInvocation``. A
    ``PromptExecution`` is inspection output only and is never accepted for execution.
    """

    def __init__(
        self,
        registry: PromptRepository,
        gateway: LLMGateway,
        model_identifier: str,
        *,
        renderer: PromptRenderer | None = None,
        estimator: TokenEstimator | None = None,
        logger: EventLogger | None = None,
        clock: Clock = time.monotonic,
    ) -> None:
        if not registry.is_sealed:
            raise ConfigurationError()
        validate_model_identifier(model_identifier)
        defaults = gateway.generation_defaults
        if defaults.max_output_tokens is None or defaults.context_window is None:
            raise ConfigurationError()
        self._registry = registry
        self._gateway = gateway
        self._model = model_identifier
        self._runtime_output = defaults.max_output_tokens
        self._runtime_context = defaults.context_window
        self._renderer = renderer or PromptRenderer()
        self._estimator: TokenEstimator = estimator or HeuristicTokenEstimator()
        self._logger = logger
        self._clock = clock

    @property
    def clock(self) -> Clock:
        """Monotonic clock used for request-budget accounting (injectable for tests)."""
        return self._clock

    @property
    def gateway(self) -> LLMGateway:
        return self._gateway

    @property
    def estimator(self) -> TokenEstimator:
        """The single authoritative estimator; context management reuses it."""
        return self._estimator

    @property
    def model_identifier(self) -> str:
        return self._model

    def prepare(self, invocation: PromptInvocation) -> PromptExecution:
        """Validate policy and assemble messages; never touches the provider."""
        started = time.perf_counter()
        try:
            execution = self._prepare(invocation, started)
        except Exception as error:
            self._reject(getattr(error, "code", "INTERNAL_ERROR"))
            raise
        metadata = execution.metadata
        if self._logger is not None:
            self._logger.event(
                logging.INFO,
                "prompt.prepared",
                metadata={
                    "outcome": "prepared",
                    "prompt_tokens": metadata.budget.prompt_tokens,
                    "duration_ms": metadata.render_duration_ms,
                },
            )
        return execution

    def _reject(self, code: str) -> None:
        if self._logger is not None:
            self._logger.event(
                logging.WARNING,
                "prompt.rejected",
                metadata={"outcome": "rejected", "error_code": code},
            )

    def resolve(self, invocation: PromptInvocation) -> ResolvedPrompt:
        """Validate and render trusted prompt parts; budget checks belong to the caller.

        The result is inspection data for trusted application services (for example the
        context manager). It is never accepted by ``complete`` or ``stream``.
        """
        if not isinstance(invocation, PromptInvocation):
            raise PromptPolicyViolationError()
        profile = self._registry.resolve_profile(invocation.profile_identifier)
        definition = self._registry.resolve(profile.prompt_identifier, profile.prompt_version)
        user_content = invocation.user_content
        if (
            not isinstance(user_content, str)
            or not user_content.strip()
            or len(user_content) > profile.policy.max_user_characters
        ):
            raise PromptPolicyViolationError()
        declared = {variable.name: variable for variable in definition.variables}
        supplied = dict(invocation.variables)
        if len(supplied) != len(invocation.variables):
            raise PromptPolicyViolationError()
        for name in supplied:
            if name not in declared:
                raise UnknownPromptVariableError()
            if declared[name].trusted:
                raise PromptPolicyViolationError()
        resolved_values: dict[str, object] = dict(profile.trusted_defaults)
        resolved_values.update(supplied)
        rendered = self._renderer.render(definition, resolved_values)

        effective_output = min(profile.policy.max_output_tokens, self._runtime_output)
        effective_context = min(profile.policy.max_context_tokens, self._runtime_context)
        requested = invocation.options
        if requested.max_output_tokens is not None and (
            requested.max_output_tokens > effective_output
        ):
            raise PromptPolicyViolationError()
        if requested.context_window is not None and requested.context_window > effective_context:
            raise PromptPolicyViolationError()
        output = requested.max_output_tokens or effective_output
        context = requested.context_window or self._runtime_context
        resolved_options = GenerationOptions(
            temperature=requested.temperature,
            max_output_tokens=output,
            context_window=context,
            stop_sequences=requested.stop_sequences,
        )
        return ResolvedPrompt(
            definition=definition,
            profile=profile,
            rendered=rendered,
            user_message=ChatMessage(MessageRole.USER, user_content),
            options=resolved_options,
            context_limit=min(effective_context, context),
            thinking=invocation.thinking,
        )

    def _prepare(self, invocation: PromptInvocation, started: float) -> PromptExecution:
        resolved = self.resolve(invocation)
        messages = (*resolved.rendered.messages, resolved.user_message)
        output = resolved.output_tokens
        budget = self._estimator.estimate(messages, output)
        if budget.total_tokens > resolved.context_limit:
            raise PromptBudgetExceededError()
        request = CompletionRequest(self._model, messages, resolved.options, resolved.thinking)
        metadata = PromptExecutionMetadata(
            resolved.definition.identifier,
            resolved.definition.version,
            resolved.profile.identifier,
            budget,
            float((time.perf_counter() - started) * 1000),
        )
        return PromptExecution(request, resolved.rendered, metadata, resolved.options)

    async def complete(
        self, invocation: PromptInvocation, *, timeout_seconds: float | None = None
    ) -> CompletionResponse:
        # The budget starts before preparation; the gateway receives only what is left.
        deadline = RequestDeadline(self._gateway.deadline_seconds(timeout_seconds), self._clock)
        execution = self.prepare(invocation)
        return await self._gateway.complete(execution.request, timeout_seconds=deadline.remaining())

    async def stream(
        self, invocation: PromptInvocation, *, timeout_seconds: float | None = None
    ) -> AsyncIterator[StreamEvent]:
        # The budget starts when iteration begins (generators are lazy), before preparation.
        deadline = RequestDeadline(self._gateway.deadline_seconds(timeout_seconds), self._clock)
        execution = self.prepare(invocation)
        async for event in self._gateway.stream(
            execution.request, timeout_seconds=deadline.remaining()
        ):
            yield event
