from typing import Literal, TypedDict


class Capabilities(TypedDict):
    configuration: bool
    ollama: bool
    inference: bool


class Readiness(TypedDict):
    service: Literal["ai-service"]
    status: Literal["ready"]
    capabilities: Capabilities
    environment: str


def describe_readiness(environment: str) -> Readiness:
    """Describe only capabilities implemented by the current service."""
    return {
        "service": "ai-service",
        "status": "ready",
        "capabilities": {
            "configuration": True,
            "ollama": False,
            "inference": False,
        },
        "environment": environment,
    }
