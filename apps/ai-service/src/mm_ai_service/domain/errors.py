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


class PayloadTooLargeError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PAYLOAD_TOO_LARGE", "The request body is too large.", 413)


class UnsupportedMediaTypeError(ServiceError):
    def __init__(self) -> None:
        super().__init__("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", 415)


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


class ModelUnavailableError(ServiceError):
    def __init__(self) -> None:
        super().__init__("MODEL_UNAVAILABLE", "The configured model is unavailable.", 503)


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


class AdmissionTimeoutError(ProviderTimeoutError):
    def __init__(self) -> None:
        ServiceError.__init__(self, "ADMISSION_TIMEOUT", "Inference admission timed out.", 503)


class FirstTokenTimeoutError(ProviderTimeoutError):
    def __init__(self) -> None:
        ServiceError.__init__(
            self, "FIRST_TOKEN_TIMEOUT", "The first content token timed out.", 504
        )


class StreamInactivityTimeoutError(ProviderTimeoutError):
    def __init__(self) -> None:
        ServiceError.__init__(
            self,
            "STREAM_INACTIVITY_TIMEOUT",
            "The inference stream became inactive.",
            504,
        )


class RequestDeadlineExceededError(ProviderTimeoutError):
    def __init__(self) -> None:
        ServiceError.__init__(
            self,
            "REQUEST_DEADLINE_EXCEEDED",
            "The request deadline was exceeded.",
            504,
        )


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


class PromptNotFoundError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROMPT_NOT_FOUND", "The requested prompt is not available.", 404)


class PromptVersionNotFoundError(ServiceError):
    def __init__(self) -> None:
        super().__init__(
            "PROMPT_VERSION_NOT_FOUND", "The requested prompt version is not available.", 404
        )


class DuplicatePromptRegistrationError(ServiceError):
    def __init__(self) -> None:
        super().__init__("DUPLICATE_PROMPT", "The prompt version is already registered.", 409)


class InvalidPromptTemplateError(ServiceError):
    def __init__(self) -> None:
        super().__init__("INVALID_PROMPT_TEMPLATE", "The prompt template is invalid.", 422)


class MissingPromptVariableError(ServiceError):
    def __init__(self) -> None:
        super().__init__("MISSING_PROMPT_VARIABLE", "A required prompt variable is missing.", 400)


class UnknownPromptVariableError(ServiceError):
    def __init__(self) -> None:
        super().__init__("UNKNOWN_PROMPT_VARIABLE", "The prompt contains an unknown variable.", 400)


class InvalidPromptVariableError(ServiceError):
    def __init__(self) -> None:
        super().__init__("INVALID_PROMPT_VARIABLE", "A prompt variable is invalid.", 400)


class PromptPolicyViolationError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROMPT_POLICY_VIOLATION", "The prompt request violates its policy.", 422)


class PromptBudgetExceededError(ServiceError):
    def __init__(self) -> None:
        super().__init__(
            "PROMPT_BUDGET_EXCEEDED", "The prompt request exceeds its token budget.", 422
        )


class PromptRegistrySealedError(ServiceError):
    def __init__(self) -> None:
        super().__init__("PROMPT_REGISTRY_SEALED", "The prompt registry is sealed.", 409)


class InvalidPromptProfileError(ServiceError):
    def __init__(self) -> None:
        super().__init__("INVALID_PROMPT_PROFILE", "The prompt profile is invalid.", 422)
