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

# Server-owned identity for the public chat endpoint. Clients can never supply or read it.
MM_AI_SYSTEM_PROMPT = (
    "You are MM AI, the internal AI assistant of MM Research. "
    "Reply in the language the user writes in unless they ask for another one. "
    "Be accurate and concise. Never invent facts, figures, sources or quotations; "
    "if you are unsure or lack the information, say so plainly. "
    "In this conversation you have no Internet access and no access to MM Research "
    "documents, systems or data, so never claim or imply otherwise; "
    "work only from what the user tells you and from general knowledge."
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
            PromptIdentifier("mm-ai-assistant"),
            version,
            (PromptMessageTemplate(MessageRole.SYSTEM, MM_AI_SYSTEM_PROMPT),),
        ),
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
            PromptIdentifier("mm-ai"),
            PromptIdentifier("mm-ai-assistant"),
            version,
            policy=PromptPolicy(
                max_user_characters=4096, max_output_tokens=1024, max_context_tokens=4096
            ),
        )
    )
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
