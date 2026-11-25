# Prompt management

Checkpoint 2.6 adds a trusted in-process prompt subsystem to the FastAPI AI service. It is an
internal application entry point, not an HTTP administration API; no public route selects a prompt
or profile.

## Flow

`PromptService` receives an untrusted `PromptInvocation` (profile id, user content, optional
untrusted variables, generation options, thinking mode). It resolves the trusted `PromptProfile`
and its exact prompt version, validates variables, renders the templates, appends the caller content
as a single `user` message, applies runtime limits and the budget check, and only then calls the
existing `LLMGateway`. The model identifier is a trusted constructor argument
(`settings.ollama_model`), never a per-call input.

`prepare()` returns an inspection-only `PromptExecution`. `complete()` and `stream()` accept only a
`PromptInvocation` and re-run preparation themselves, so a hand-built or modified `PromptExecution`
can never reach the provider (it is rejected with `PROMPT_POLICY_VIOLATION`). The gateway remains
the only inference path and the authority for admission, deadlines, cancellation and capability
checks.

## Registry lifecycle and versioning

`PromptRegistry` is mutable only during startup: `register`, `register_profile`, `set_default`.
`seal()` validates the asset graph (every prompt has an explicit default, every profile references
an existing prompt version) and then every further mutation raises `PROMPT_REGISTRY_SEALED`.
`PromptService` refuses an unsealed registry and depends only on the read-only `PromptRepository`
protocol. `create_app` builds a fresh registry per application instance, so instances are isolated.
There is no runtime CRUD, persistence, discovery or remote registry.

Versions are immutable `(identifier, version)` snapshots. Duplicates are rejected, the default is
explicit, and older versions stay independently resolvable. Profiles must reference valid trusted
defaults, and every required trusted variable must have a profile value.

## Rendering

Templates allow only `{{variable_name}}` (`[a-z][a-z0-9_]*`). Rendering scans the **original**
template once with the placeholder pattern and splices values in; substituted text is never
re-scanned, so a value such as `{{b}}` stays literal (Checkpoint 2.6 audit finding F01: the first
implementation replaced variables sequentially and could expand placeholders inside earlier values).
Output does not depend on variable declaration or mapping order. There is no expression language,
traversal, call, import, filesystem or network access; malformed or expression-like placeholders are
rejected when the template is created. Rendered size is bounded by the definition.

Variables are strictly typed (string, integer, boolean, string collection) with no coercion, and
bounded. Value validation failures raise `INVALID_PROMPT_VARIABLE`; unexpected internal defects are
not converted into validation errors and follow the normal 500 handling (finding F04).

## Runtime limits and options

Effective output and context limits are `min(profile policy, gateway generation defaults)`; the
gateway exposes its defaults read-only. Explicit caller options above those limits are rejected, not
silently clipped. Without explicit options the profile output limit and the runtime context window
are used. Thinking mode is passed to the gateway, which rejects unsupported capabilities; reasoning
tokens count inside `max_output_tokens`, which is included in the budget.

## Budget estimation (limitations)

Estimators implement the model-neutral `TokenEstimator` port and label each result with
`BudgetAccuracy`:

| Estimator                           | Accuracy      | Meaning                                                                                                                                                                                                     |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HeuristicTokenEstimator` (default) | `ESTIMATE`    | Character-class weights plus 8 tokens per message and 8 for reply priming. Cautious for ordinary Vietnamese, English, CJK and emoji, but **not** a proven bound; adversarial or unusual text can exceed it. |
| `Utf8ByteUpperBoundEstimator`       | `UPPER_BOUND` | UTF-8 bytes plus framing. A true bound only for byte-level BPE or byte-fallback tokenizers; about 1 token per byte, so it rejects roughly twice as much Vietnamese text.                                    |
| (none yet)                          | `EXACT`       | Requires the model tokenizer; no tokenizer is downloaded or bundled.                                                                                                                                        |

The previous rule (4 + bytes/2 per message) counted 500 digits as about 254 tokens, which is not
conservative for tokenizers that emit one token per digit (finding F03). Chat-template overhead is
approximated, not derived from the real template. Requests over budget are rejected, never
truncated. Provider-reported usage is the only authoritative count and can differ from the estimate.

## Metadata and logging

`PromptService` optionally logs `prompt.prepared` / `prompt.rejected` with `outcome`,
`prompt_tokens`, `duration_ms` or `error_code` only, through the existing allowlisting logger. It
never logs templates, variable values, user content, completions or reasoning.

## Built-ins

`general`, `research` and `document-analysis` profiles over versioned prompts, registered and sealed
at composition time in `infrastructure/prompts.py`. They are profiles, not agents. The 12 specialised
agents are a future objective and are not implemented.
