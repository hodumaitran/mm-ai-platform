# Context budget policy

## Effective limit

The effective context limit is `min(profile max_context_tokens, gateway context window, explicit
caller context_window)`. The gateway value is the configured runtime window (default 4,096), not the
model's advertised maximum. Output tokens are `min(profile max_output_tokens, gateway default,
explicit)`. Explicit caller options above these limits are rejected, never rewritten. Thinking-mode
requests are validated by the gateway; reasoning tokens consume the same `max_output_tokens`
reservation, so no separate thinking budget exists.

## Accounting

```text
committed = mandatory + history + reference + output reservation + safety margin <= effective limit
```

- **Mandatory**: rendered trusted prompt plus the current request. Estimated once with the same
  `TokenEstimator` as Prompt Management (no competing estimator). It is never truncated: if
  `mandatory + output + margin` does not fit, preparation fails with `CONTEXT_BUDGET_EXCEEDED`
  before any provider call.
- **Output reservation**: the resolved `max_output_tokens`.
- **Safety margin**: `ContextSelectionPolicy.safety_margin_tokens` (default 128). It absorbs estimator
  error and chat-template differences but is not a guarantee.
- **Optional**: `remaining = effective - committed-so-far`, consumed by history first, then references.

## Selection (deterministic, no ranking)

1. Trusted prompt and current request: always kept.
2. History: newest turn first, whole turns only (user and assistant together). Stop at the first turn
   that exceeds the turn limit or the remaining budget; all older turns are excluded, so history never
   has gaps. Kept turns are emitted oldest-first.
3. Reference material: caller order, first fit. An item that does not fit (or exceeds the item limit)
   is excluded and later, smaller items may still be kept. Equal-priority order is therefore stable
   and caller-defined.

Every excluded unit is reported with its identifier, source, an `ExclusionReason` (`turn_limit`,
`item_limit`, `token_budget`) and its estimated cost. There is no character-level truncation and no
semantic scoring.

## Estimation limits

Costs per message come from `estimate((message,), 0) - estimate((), 0)`; this assumes the estimator
is additive over messages. For both bundled estimators the sum of marginals is at most one token per
message above the whole-list estimate (conservative), and each message is estimated once per
preparation. The default `HeuristicTokenEstimator` is a labelled **estimate**, not a bound. The
`Utf8ByteUpperBoundEstimator` is a bound only for byte-level tokenizers and is much more pessimistic.
Provider-reported `usage.prompt_tokens` remains the only authoritative count; the measured
estimated-versus-observed comparison is in the checkpoint report. Policy is not tuned from that small
sample.

## Failure modes

| Condition                                 | Error                          |
| ----------------------------------------- | ------------------------------ |
| Mandatory content cannot fit              | `CONTEXT_BUDGET_EXCEEDED` 422  |
| Invalid history / snapshot                | `INVALID_CONVERSATION` 400     |
| Invalid or colliding reference / item id  | `INVALID_CONTEXT_ITEM` 400     |
| Invalid policy or inconsistent budget     | `INVALID_CONTEXT_POLICY` 422   |
| Wrong object type / forged execution data | `CONTEXT_POLICY_VIOLATION` 422 |
| Prompt, option, or limit violations       | existing `PROMPT_*` errors     |

All fail before the provider is invoked, with sanitized public messages.
