# ADR 0007: Centralize immutable prompt management in the AI service

## Status

Accepted for Checkpoint 2.6.

## Decision

Use immutable domain contracts, a trusted in-memory registry that is sealed at startup, a
restricted single-pass renderer, explicit profile policies and a replaceable, accuracy-labelled
token-estimator port. Built-ins are registered and sealed at composition time. The only execution
API takes an untrusted `PromptInvocation`; preparation is owned by `PromptService`, the model is a
trusted constructor argument, runtime limits come from the existing `LLMGateway`, and every
execution goes through that gateway.

## Consequences

Version selection is explicit, duplicate versions are forbidden, registry mutation after startup is
impossible, and no persistence, remote registry, discovery, public CRUD, agent framework,
provider-specific prompt logic or context management is introduced. A caller cannot forge an
execution object. Budget checks are estimates unless a real tokenizer is supplied through the
`TokenEstimator` port; this is documented rather than hidden. Future repository and tokenizer
implementations can replace the boundaries without changing consumers.
