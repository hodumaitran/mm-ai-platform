from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ServiceError(Exception):
    """A safe, machine-readable failure that may cross the HTTP boundary."""

    code: str
    public_message: str
    status_code: int


class InvalidRequestError(ServiceError):
    def __init__(self, message: str = "The request is invalid.") -> None:
        super().__init__("INVALID_REQUEST", message, 400)


class ConfigurationError(ServiceError):
    def __init__(self) -> None:
        super().__init__("CONFIGURATION_ERROR", "The service is misconfigured.", 500)


class CapabilityUnavailableError(ServiceError):
    def __init__(self) -> None:
        super().__init__(
            "CAPABILITY_UNAVAILABLE",
            "The requested capability is unavailable.",
            503,
        )
