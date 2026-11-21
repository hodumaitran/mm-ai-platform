import pytest

from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    ConfigurationError,
    NoProviderConfiguredError,
    UnknownProviderError,
)
from mm_ai_service.domain.llm import CompletionRequest
from tests.fakes import FakeProvider, empty_stream, response_for


async def _complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
    return response_for(request)


def test_registry_selects_exact_configured_provider() -> None:
    first = FakeProvider(_complete, empty_stream, provider_id="first")
    second = FakeProvider(_complete, empty_stream, provider_id="second")
    registry = ProviderRegistry((first, second), "second")
    assert registry.resolve() is second
    assert registry.is_available is True


def test_registry_reports_no_configured_provider() -> None:
    registry = ProviderRegistry((), None)
    assert registry.is_available is False
    with pytest.raises(NoProviderConfiguredError):
        registry.resolve()


def test_registry_rejects_unknown_provider_without_fallback() -> None:
    registry = ProviderRegistry((), "missing")
    with pytest.raises(UnknownProviderError):
        registry.resolve()


def test_registry_rejects_duplicate_or_invalid_provider_ids() -> None:
    provider = FakeProvider(_complete, empty_stream)
    with pytest.raises(ConfigurationError):
        ProviderRegistry((provider, provider), "fake")
    invalid = FakeProvider(_complete, empty_stream, provider_id="INVALID ID")
    with pytest.raises(ConfigurationError):
        ProviderRegistry((invalid,), "INVALID ID")
