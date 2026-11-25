"""Trusted built-in prompt assets registered during composition only."""

from mm_ai_service.application.prompts import PromptRegistry
from mm_ai_service.domain.llm import MessageRole
from mm_ai_service.domain.prompts import (
    PromptDefinition,
    PromptIdentifier,
    PromptMessageTemplate,
    PromptPolicy,
    PromptProfile,
    PromptVariableDefinition,
    PromptVariableType,
    PromptVersion,
)


def build_builtin_prompt_registry() -> PromptRegistry:
    registry = PromptRegistry()
    version = PromptVersion("1")
    organization = PromptVariableDefinition(
        "organization",
        PromptVariableType.STRING,
        required=False,
        default="MM Research",
        max_length=120,
        trusted=True,
    )
    definitions = (
        PromptDefinition(
            PromptIdentifier("general-assistant"),
            version,
            (PromptMessageTemplate(MessageRole.SYSTEM, "You are a helpful enterprise assistant."),),
        ),
        PromptDefinition(
            PromptIdentifier("research-assistant"),
            version,
            (
                PromptMessageTemplate(
                    MessageRole.SYSTEM,
                    "You are a careful research assistant for {{organization}}. "
                    "State uncertainty clearly.",
                ),
            ),
            (organization,),
        ),
        PromptDefinition(
            PromptIdentifier("document-analysis"),
            version,
            (
                PromptMessageTemplate(
                    MessageRole.SYSTEM,
                    "You analyze supplied documents. "
                    "Do not invent facts absent from the user content.",
                ),
            ),
        ),
    )
    for definition in definitions:
        registry.register(definition, default=True)
    registry.register_profile(
        PromptProfile(
            PromptIdentifier("general"),
            PromptIdentifier("general-assistant"),
            version,
            policy=PromptPolicy(
                max_user_characters=4096, max_output_tokens=512, max_context_tokens=4096
            ),
        )
    )
    registry.register_profile(
        PromptProfile(
            PromptIdentifier("research"),
            PromptIdentifier("research-assistant"),
            version,
            trusted_defaults=(("organization", "MM Research"),),
            policy=PromptPolicy(
                max_user_characters=4096, max_output_tokens=512, max_context_tokens=4096
            ),
        )
    )
    registry.register_profile(
        PromptProfile(
            PromptIdentifier("document-analysis"),
            PromptIdentifier("document-analysis"),
            version,
            policy=PromptPolicy(
                max_user_characters=4096, max_output_tokens=512, max_context_tokens=4096
            ),
        )
    )
    registry.seal()
    return registry
