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


class InvalidCompletionRequestError(ServiceError):
    def __init__(self) -> None:
        super().__init__("INVALID_COMPLETION_REQUEST", "The completion request is invalid.", 400)


class ProviderUnavailableError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROVIDER_UNAVAILABLE", "The configured provider is unavailable.", 503)


class NoProviderConfiguredError(ProviderUnavailableError):
    def __init__(self) -> None:
        ServiceError.__init__(self, "PROVIDER_UNAVAILABLE", "No LLM provider is configured.", 503)


class UnknownProviderError(ProviderUnavailableError):
    def __init__(self) -> None:
        ServiceError.__init__(
            self,
            "PROVIDER_UNAVAILABLE",
            "The configured LLM provider is not registered.",
            503,
        )


class ProviderConnectionError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROVIDER_CONNECTION_FAILURE", "The provider connection failed.", 503)


class ProviderTimeoutError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROVIDER_TIMEOUT", "The provider request timed out.", 504)


class ProviderOverloadError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROVIDER_OVERLOAD", "The provider is overloaded.", 503)


class UnsupportedCapabilityError(ServiceError):
    def __init__(self) -> None:
        super().__init__("UNSUPPORTED_CAPABILITY", "The requested capability is unsupported.", 422)


class InvalidProviderResponseError(ServiceError):
    def __init__(self) -> None:
        super().__init__(
            "INVALID_PROVIDER_RESPONSE",
            "The provider returned an invalid response.",
            502,
        )


class RequestCancelledError(ServiceError):
    def __init__(self) -> None:
        super().__init__("REQUEST_CANCELLED", "The request was cancelled.", 499)


class InternalGatewayError(ServiceError):
    def __init__(self) -> None:
        super().__init__("INTERNAL_GATEWAY_FAILURE", "The LLM gateway failed.", 500)
