from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict


class Capabilities(TypedDict):
    configuration: bool
    ollama: bool
    model: bool
    inference: bool


class Readiness(TypedDict):
    service: Literal["ai-service"]
    status: Literal["ready"]
    capabilities: Capabilities
    environment: str


@dataclass(frozen=True, slots=True)
class ProviderReadiness:
    provider_available: bool = False
    model_available: bool = False
    inference_available: bool = False


class ReadinessProbe(Protocol):
    async def check_readiness(self) -> ProviderReadiness: ...


def describe_readiness(
    environment: str,
    provider: ProviderReadiness = ProviderReadiness(),
) -> Readiness:
    """Describe only capabilities implemented by the current service."""
    return {
        "service": "ai-service",
        "status": "ready",
        "capabilities": {
            "configuration": True,
            "ollama": provider.provider_available,
            "model": provider.model_available,
            "inference": provider.inference_available,
        },
        "environment": environment,
    }
