from enum import StrEnum
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictTransportModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PublicMessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class PublicThinkingMode(StrEnum):
    DISABLED = "disabled"
    ENABLED = "enabled"


class ChatMessageRequest(StrictTransportModel):
    role: PublicMessageRole
    content: str = Field(min_length=1, max_length=65536)


class GenerationRequest(StrictTransportModel):
    temperature: float = Field(default=0.2, ge=0, le=2, allow_inf_nan=False)
    max_output_tokens: int = Field(default=256, ge=1, le=65536)


class ThinkingRequest(StrictTransportModel):
    mode: PublicThinkingMode = PublicThinkingMode.DISABLED


class ChatCompletionRequest(StrictTransportModel):
    version: str = Field(default="1", pattern=r"^1$")
    messages: tuple[ChatMessageRequest, ...] = Field(min_length=1, max_length=128)
    generation: GenerationRequest = Field(default_factory=GenerationRequest)
    thinking: ThinkingRequest = Field(default_factory=ThinkingRequest)

    @model_validator(mode="after")
    def validate_conversation(self) -> Self:
        expected = PublicMessageRole.USER
        for message in self.messages:
            if message.role is not expected or not message.content.strip():
                raise ValueError("messages must alternate user and assistant roles")
            expected = (
                PublicMessageRole.ASSISTANT
                if expected is PublicMessageRole.USER
                else PublicMessageRole.USER
            )
        if self.messages[-1].role is not PublicMessageRole.USER:
            raise ValueError("the final message must have the user role")
        return self


class ChatMessageResponse(StrictTransportModel):
    role: str = Field(pattern=r"^assistant$")
    content: str = Field(min_length=1)


class TokenUsageResponse(StrictTransportModel):
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ChatCompletionResponse(StrictTransportModel):
    version: str = "1"
    request_id: str
    model: str
    message: ChatMessageResponse
    finish_reason: str
    usage: TokenUsageResponse
