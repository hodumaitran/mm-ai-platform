from collections.abc import Sequence
from types import MappingProxyType

from mm_ai_service.application.providers import LLMProvider
from mm_ai_service.domain.errors import (
    ConfigurationError,
    NoProviderConfiguredError,
    UnknownProviderError,
)
from mm_ai_service.domain.llm import is_valid_provider_identifier


class ProviderRegistry:
    """An explicit, immutable provider registry with one configured selection."""

    def __init__(
        self,
        providers: Sequence[LLMProvider],
        configured_provider_id: str | None,
    ) -> None:
        registered: dict[str, LLMProvider] = {}
        for provider in providers:
            provider_id = provider.provider_id
            if not is_valid_provider_identifier(provider_id) or provider_id in registered:
                raise ConfigurationError()
            registered[provider_id] = provider
        if configured_provider_id is not None and not is_valid_provider_identifier(
            configured_provider_id
        ):
            raise ConfigurationError()
        self._providers = MappingProxyType(registered)
        self._configured_provider_id = configured_provider_id

    @property
    def is_available(self) -> bool:
        return (
            self._configured_provider_id is not None
            and self._configured_provider_id in self._providers
        )

    def resolve(self) -> LLMProvider:
        if self._configured_provider_id is None:
            raise NoProviderConfiguredError()
        provider = self._providers.get(self._configured_provider_id)
        if provider is None:
            raise UnknownProviderError()
        return provider
