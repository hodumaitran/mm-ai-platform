import asyncio
import itertools
import json
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

import httpx

from mm_ai_service.application.readiness import ProviderReadiness
from mm_ai_service.domain.errors import (
    InvalidProviderResponseError,
    ModelUnavailableError,
    ProviderConnectionError,
    ProviderOverloadError,
    ProviderTimeoutError,
    ProviderUnavailableError,
    ServiceError,
    UnsupportedCapabilityError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    FinishReason,
    MessageRole,
    ModelCapabilities,
    StreamError,
    StreamEvent,
    StreamStarted,
    ThinkingMode,
    TokenUsage,
)
from mm_ai_service.domain.tools import ParameterType, ToolCall, ToolDefinition

type JsonObject = dict[str, Any]


class OllamaProvider:
    """Loopback/private-network Ollama adapter with an owned pooled HTTP client."""

    provider_id = "ollama"

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        context_window: int,
        connect_timeout_seconds: float,
        read_timeout_seconds: float,
        readiness_timeout_seconds: float,
        readiness_cache_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._context_window = context_window
        self._connect_timeout_seconds = connect_timeout_seconds
        self._read_timeout_seconds = read_timeout_seconds
        self._readiness_timeout_seconds = readiness_timeout_seconds
        self._readiness_cache_seconds = readiness_cache_seconds
        self._transport = transport
        self._clock = clock
        self._client: httpx.AsyncClient | None = None
        self._readiness = ProviderReadiness()
        self._readiness_expires_at = 0.0
        self._readiness_lock = asyncio.Lock()
        self._capabilities = self._conservative_capabilities()
        self._call_sequence = itertools.count(1)

    @property
    def capabilities(self) -> ModelCapabilities:
        return self._capabilities

    async def start(self) -> None:
        if self._client is not None:
            return
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(
                connect=self._connect_timeout_seconds,
                read=self._read_timeout_seconds,
                write=self._connect_timeout_seconds,
                pool=self._connect_timeout_seconds,
            ),
            limits=httpx.Limits(max_connections=2, max_keepalive_connections=1),
            follow_redirects=False,
            trust_env=False,
            transport=self._transport,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        await self._get_readiness(force=True)

    async def stop(self) -> None:
        client, self._client = self._client, None
        self._readiness = ProviderReadiness()
        self._readiness_expires_at = 0.0
        if client is not None:
            await client.aclose()

    async def check_readiness(self) -> ProviderReadiness:
        return await self._get_readiness(force=False)

    async def complete(self, request: CompletionRequest) -> CompletionResponse:
        self._validate_requested_model(request.model_identifier)
        payload = self._chat_payload(request, stream=False)
        response = await self._post_json("/api/chat", payload)
        return self._completion_response(response, request.model_identifier)

    async def stream(self, request: CompletionRequest) -> AsyncIterator[StreamEvent]:
        self._validate_requested_model(request.model_identifier)
        if request.tools:
            raise UnsupportedCapabilityError()  # tool-enabled streaming is not supported
        client = self._client_or_raise()
        payload = self._chat_payload(request, stream=True)
        try:
            async with client.stream("POST", "/api/chat", json=payload) as response:
                self._raise_for_status(response)
                yield StreamStarted(request.model_identifier)
                terminal_seen = False
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    chunk = self._decode_object(line)
                    if "error" in chunk:
                        yield StreamError(
                            "PROVIDER_UNAVAILABLE",
                            "The provider stream failed.",
                        )
                        terminal_seen = True
                        break
                    self._validate_response_model(chunk, request.model_identifier)
                    message = chunk.get("message")
                    if not isinstance(message, dict):
                        raise InvalidProviderResponseError()
                    content = message.get("content")
                    if not isinstance(content, str):
                        raise InvalidProviderResponseError()
                    if content:
                        yield ContentDelta(content)
                    done = chunk.get("done")
                    if not isinstance(done, bool):
                        raise InvalidProviderResponseError()
                    if done:
                        yield CompletionFinished(
                            self._finish_reason(chunk.get("done_reason")),
                            self._usage(chunk),
                        )
                        terminal_seen = True
                        break
                if not terminal_seen:
                    raise InvalidProviderResponseError()
        except asyncio.CancelledError:
            raise
        except httpx.ConnectTimeout as error:
            raise ProviderConnectionError() from error
        except httpx.TimeoutException as error:
            raise ProviderTimeoutError() from error
        except httpx.RequestError as error:
            raise ProviderConnectionError() from error

    async def _get_readiness(self, *, force: bool) -> ProviderReadiness:
        if self._client is None:
            return ProviderReadiness()
        now = self._clock()
        if not force and now < self._readiness_expires_at:
            return self._readiness
        async with self._readiness_lock:
            now = self._clock()
            if not force and now < self._readiness_expires_at:
                return self._readiness
            try:
                async with asyncio.timeout(self._readiness_timeout_seconds):
                    readiness = await self._probe_readiness()
            except (TimeoutError, ServiceError):
                readiness = ProviderReadiness()
            if not readiness.inference_available:
                self._capabilities = self._conservative_capabilities()
            self._readiness = readiness
            self._readiness_expires_at = now + self._readiness_cache_seconds
            return readiness

    async def _probe_readiness(self) -> ProviderReadiness:
        version = await self._get_json("/api/version")
        if not isinstance(version.get("version"), str):
            raise InvalidProviderResponseError()
        tags = await self._get_json("/api/tags")
        models = tags.get("models")
        if not isinstance(models, list):
            raise InvalidProviderResponseError()
        listed = any(
            isinstance(item, dict)
            and (item.get("name") == self._model or item.get("model") == self._model)
            for item in models
        )
        if not listed:
            return ProviderReadiness(provider_available=True)
        try:
            details = await self._post_json(
                "/api/show",
                {"model": self._model, "verbose": False},
            )
        except ModelUnavailableError:
            return ProviderReadiness(provider_available=True)
        capabilities = details.get("capabilities")
        if not isinstance(capabilities, list) or not all(
            isinstance(capability, str) for capability in capabilities
        ):
            raise InvalidProviderResponseError()
        supports_completion = "completion" in capabilities
        supports_thinking = self._supports_thinking(details, capabilities)
        context_limit = self._context_limit(details)
        self._capabilities = ModelCapabilities(
            chat=supports_completion,
            streaming=supports_completion,
            thinking=supports_thinking,
            tool_calling=supports_completion and "tools" in capabilities,
            structured_output=False,
            max_context_tokens=context_limit,
        )
        return ProviderReadiness(
            provider_available=True,
            model_available=True,
            inference_available=supports_completion,
        )

    async def _get_json(self, path: str) -> JsonObject:
        client = self._client_or_raise()
        try:
            response = await client.get(path)
        except asyncio.CancelledError:
            raise
        except httpx.ConnectTimeout as error:
            raise ProviderConnectionError() from error
        except httpx.TimeoutException as error:
            raise ProviderTimeoutError() from error
        except httpx.RequestError as error:
            raise ProviderConnectionError() from error
        self._raise_for_status(response)
        return self._decode_response(response)

    async def _post_json(self, path: str, payload: JsonObject) -> JsonObject:
        client = self._client_or_raise()
        try:
            response = await client.post(path, json=payload)
        except asyncio.CancelledError:
            raise
        except httpx.ConnectTimeout as error:
            raise ProviderConnectionError() from error
        except httpx.TimeoutException as error:
            raise ProviderTimeoutError() from error
        except httpx.RequestError as error:
            raise ProviderConnectionError() from error
        self._raise_for_status(response)
        return self._decode_response(response)

    def _client_or_raise(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            raise ProviderUnavailableError()
        return self._client

    def _validate_requested_model(self, model_identifier: str) -> None:
        if model_identifier != self._model:
            raise ModelUnavailableError()

    def _chat_payload(self, request: CompletionRequest, *, stream: bool) -> JsonObject:
        options = request.options
        payload: JsonObject = {
            "model": self._model,
            "messages": [self._message_payload(message) for message in request.messages],
            "stream": stream,
            "options": {
                "temperature": options.temperature,
                "num_predict": options.max_output_tokens,
                "num_ctx": options.context_window,
                "stop": list(options.stop_sequences),
            },
        }
        if request.tools:
            payload["tools"] = [self._tool_payload(tool) for tool in request.tools]
        if request.thinking.mode is ThinkingMode.ENABLED:
            payload["think"] = True
        elif request.thinking.mode is ThinkingMode.DISABLED:
            payload["think"] = False
        return payload

    @staticmethod
    def _message_payload(message: ChatMessage) -> JsonObject:
        payload: JsonObject = {"role": message.role.value, "content": message.content}
        if message.tool_calls:
            payload["tool_calls"] = [
                {"function": {"name": call.tool_name, "arguments": dict(call.arguments)}}
                for call in message.tool_calls
            ]
        if message.role is MessageRole.TOOL:
            payload["tool_name"] = message.tool_name
        return payload

    @staticmethod
    def _tool_payload(tool: ToolDefinition) -> JsonObject:
        """Map a model-neutral definition to Ollama's native function-tool schema."""
        properties: JsonObject = {}
        for parameter in tool.parameters:
            schema: JsonObject = {
                "type": parameter.type.value,
                "description": parameter.description,
            }
            if parameter.type in (ParameterType.INTEGER, ParameterType.NUMBER):
                if parameter.minimum is not None:
                    schema["minimum"] = parameter.minimum
                if parameter.maximum is not None:
                    schema["maximum"] = parameter.maximum
            if parameter.type is ParameterType.STRING:
                schema["maxLength"] = parameter.max_length
                if parameter.allowed_values is not None:
                    schema["enum"] = list(parameter.allowed_values)
            properties[parameter.name] = schema
        return {
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": [item.name for item in tool.parameters if item.required],
                    "additionalProperties": False,
                },
            },
        }

    def _tool_calls(self, message: JsonObject) -> tuple[ToolCall, ...]:
        """Strictly parse native tool calls; anything malformed rejects the whole response."""
        raw = message.get("tool_calls")
        if raw is None:
            return ()
        if not isinstance(raw, list) or len(raw) > 8:
            raise InvalidProviderResponseError()
        calls: list[ToolCall] = []
        for item in raw:
            function = item.get("function") if isinstance(item, dict) else None
            if not isinstance(function, dict):
                raise InvalidProviderResponseError()
            name = function.get("name")
            arguments = function.get("arguments")
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise InvalidProviderResponseError()
            try:
                calls.append(ToolCall(f"call_{next(self._call_sequence)}", name, arguments))
            except ServiceError:
                raise InvalidProviderResponseError() from None
        return tuple(calls)

    def _completion_response(
        self,
        payload: JsonObject,
        requested_model: str,
    ) -> CompletionResponse:
        self._validate_response_model(payload, requested_model)
        if payload.get("done") is not True:
            raise InvalidProviderResponseError()
        message = payload.get("message")
        if not isinstance(message, dict):
            raise InvalidProviderResponseError()
        role = message.get("role")
        content = message.get("content")
        if role != "assistant" or not isinstance(content, str):
            raise InvalidProviderResponseError()
        tool_calls = self._tool_calls(message)
        if not tool_calls and not content.strip():
            raise InvalidProviderResponseError()
        return CompletionResponse(
            model_identifier=requested_model,
            message=ChatMessage(MessageRole.ASSISTANT, content, tool_calls),
            finish_reason=(
                FinishReason.TOOL_CALL
                if tool_calls
                else self._finish_reason(payload.get("done_reason"))
            ),
            usage=self._usage(payload),
        )

    @staticmethod
    def _supports_thinking(details: JsonObject, capabilities: list[Any]) -> bool:
        if "thinking" not in capabilities:
            return False
        thinking = details.get("thinking")
        if not isinstance(thinking, dict):
            return True
        values = thinking.get("values")
        return isinstance(values, list) and any(value is not False for value in values)

    def _context_limit(self, details: JsonObject) -> int:
        model_info = details.get("model_info")
        if not isinstance(model_info, dict):
            return self._context_window
        declared = [
            value
            for key, value in model_info.items()
            if isinstance(key, str)
            and key.endswith(".context_length")
            and isinstance(value, int)
            and not isinstance(value, bool)
            and value > 0
        ]
        return min(self._context_window, min(declared)) if declared else self._context_window

    def _conservative_capabilities(self) -> ModelCapabilities:
        return ModelCapabilities(
            chat=True,
            streaming=True,
            thinking=False,
            tool_calling=False,
            structured_output=False,
            max_context_tokens=self._context_window,
        )

    @staticmethod
    def _usage(payload: JsonObject) -> TokenUsage:
        prompt = OllamaProvider._optional_count(payload.get("prompt_eval_count"))
        completion = OllamaProvider._optional_count(payload.get("eval_count"))
        total = prompt + completion if prompt is not None and completion is not None else None
        return TokenUsage(prompt, completion, total)

    @staticmethod
    def _optional_count(value: object) -> int | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise InvalidProviderResponseError()
        return value

    @staticmethod
    def _finish_reason(value: object) -> FinishReason:
        if value in (None, "stop"):
            return FinishReason.STOP
        if value == "length":
            return FinishReason.LENGTH
        if value == "cancelled":
            return FinishReason.CANCELLED
        return FinishReason.OTHER

    @staticmethod
    def _validate_response_model(payload: JsonObject, requested_model: str) -> None:
        if payload.get("model") != requested_model:
            raise InvalidProviderResponseError()

    @staticmethod
    def _decode_response(response: httpx.Response) -> JsonObject:
        try:
            payload = response.json()
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise InvalidProviderResponseError() from error
        if not isinstance(payload, dict):
            raise InvalidProviderResponseError()
        return payload

    @staticmethod
    def _decode_object(value: str) -> JsonObject:
        try:
            payload = json.loads(value)
        except json.JSONDecodeError as error:
            raise InvalidProviderResponseError() from error
        if not isinstance(payload, dict):
            raise InvalidProviderResponseError()
        return payload

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        status = response.status_code
        if 200 <= status < 300:
            return
        if status == 404:
            raise ModelUnavailableError()
        if status == 429:
            raise ProviderOverloadError()
        if status in (408, 504):
            raise ProviderTimeoutError()
        if status >= 500:
            raise ProviderUnavailableError()
        raise InvalidProviderResponseError()
