import asyncio
import time
from collections.abc import AsyncIterator, Sequence

import pytest

from mm_ai_service.application.context import ContextService
from mm_ai_service.application.deadline import RequestDeadline
from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.prompts import PromptService
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import (
    PromptPolicyViolationError,
    ProviderOverloadError,
    RequestDeadlineExceededError,
)
from mm_ai_service.domain.llm import (
    ChatMessage,
    CompletionFinished,
    CompletionRequest,
    CompletionResponse,
    ContentDelta,
    FinishReason,
    ModelCapabilities,
    StreamEvent,
    StreamStarted,
)
from mm_ai_service.domain.prompts import (
    BudgetAccuracy,
    PromptBudget,
    PromptIdentifier,
    PromptInvocation,
)
from tests.fakes import FakeProvider, response_for
from tests.test_context_management import MODEL, _invocation, _registry


class FakeClock:
    """Controlled monotonic clock: time moves only when a test (or fake work) advances it."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class AdvancingEstimator:
    """Linear estimator whose every call consumes ``step`` seconds of the fake clock."""

    def __init__(self, clock: FakeClock, step: float) -> None:
        self._clock = clock
        self._step = step
        self.calls = 0

    def estimate(self, messages: Sequence[ChatMessage], output_tokens: int) -> PromptBudget:
        self.calls += 1
        self._clock.now += self._step
        prompt = sum(len(message.content) for message in messages)
        return PromptBudget(prompt, output_tokens, prompt + output_tokens, BudgetAccuracy.ESTIMATE)


class RecordingGateway(LLMGateway):
    """Real gateway that records the budget each execution call actually receives."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self.received: list[float | None] = []

    async def complete(
        self, request: CompletionRequest, *, timeout_seconds: float | None = None
    ) -> CompletionResponse:
        self.received.append(timeout_seconds)
        return await super().complete(request, timeout_seconds=timeout_seconds)

    async def stream(  # type: ignore[override]
        self, request: CompletionRequest, *, timeout_seconds: float | None = None
    ) -> AsyncIterator[StreamEvent]:
        self.received.append(timeout_seconds)
        async for event in super().stream(request, timeout_seconds=timeout_seconds):
            yield event


class Harness:
    def __init__(
        self,
        *,
        step: float = 0.0,
        gateway_timeout: float = 300.0,
        concurrency: int = 1,
        pending: int = 1,
        hold: asyncio.Event | None = None,
    ) -> None:
        self.clock = FakeClock()
        self.estimator = AdvancingEstimator(self.clock, step)
        self.provider_calls = 0
        self.hold = hold

        async def complete(request: CompletionRequest) -> CompletionResponse:
            self.provider_calls += 1
            if self.hold is not None:
                await self.hold.wait()
            return response_for(request)

        async def stream(request: CompletionRequest) -> AsyncIterator[StreamEvent]:
            self.provider_calls += 1
            yield StreamStarted(request.model_identifier)
            yield ContentDelta("a")
            yield CompletionFinished(FinishReason.STOP)

        provider = FakeProvider(
            complete,
            stream,
            capabilities=ModelCapabilities(streaming=True, max_context_tokens=8192),
        )
        self.gateway = RecordingGateway(
            ProviderRegistry((provider,), provider.provider_id),
            GatewayPolicy(
                max_concurrency=concurrency,
                max_pending_requests=pending,
                request_timeout_seconds=gateway_timeout,
            ),
        )
        self.prompts = PromptService(
            _registry(), self.gateway, MODEL, estimator=self.estimator, clock=self.clock
        )
        self.context = ContextService(self.prompts)


async def _drain(stream: AsyncIterator[StreamEvent]) -> list[StreamEvent]:
    return [event async for event in stream]


def _prompt(content: str = "hi") -> PromptInvocation:
    return PromptInvocation(PromptIdentifier("chat"), content)


# --- accounting primitive and gateway budget --------------------------------------------------


def test_request_deadline_uses_the_injected_monotonic_clock() -> None:
    clock = FakeClock()
    deadline = RequestDeadline(2.0, clock)
    assert deadline.remaining() == pytest.approx(2.0)
    clock.now += 0.5
    assert deadline.remaining() == pytest.approx(1.5)
    clock.now += 1.5  # exactly exhausted counts as expired
    with pytest.raises(RequestDeadlineExceededError):
        deadline.remaining()
    clock.now += 10
    with pytest.raises(RequestDeadlineExceededError):
        deadline.remaining()


def test_default_clock_is_monotonic_and_gateway_budget_is_capped_and_validated() -> None:
    harness = Harness(gateway_timeout=10.0)
    assert PromptService(_registry(), harness.gateway, MODEL).clock is time.monotonic
    gateway = harness.gateway
    assert gateway.deadline_seconds(None) == 10.0
    assert gateway.deadline_seconds(4) == 4.0
    assert gateway.deadline_seconds(999) == 10.0
    for invalid in (0, -1, True, "5", 0.0):
        with pytest.raises(RequestDeadlineExceededError):
            gateway.deadline_seconds(invalid)  # type: ignore[arg-type]


# --- ContextService: preparation is part of the request budget --------------------------------


def test_preparation_that_consumes_the_whole_budget_never_reaches_the_provider() -> None:
    """Regression for the confirmed defect: preparation ran before the deadline started."""
    harness = Harness(step=0.5)  # preparation makes 2 estimates = 1.0 s of the fake clock
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(harness.context.complete(_invocation("hi"), timeout_seconds=1.0))
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(_drain(harness.context.stream(_invocation("hi"), timeout_seconds=1.0)))
    assert harness.provider_calls == 0
    assert harness.gateway.received == []  # rejected before the gateway was even called
    assert harness.estimator.calls == 4  # preparation did run (it cannot be preempted)


def test_preparation_that_consumes_part_of_the_budget_leaves_only_the_remainder() -> None:
    harness = Harness(step=0.2)  # 2 estimates = 0.4 s
    response = asyncio.run(harness.context.complete(_invocation("hi"), timeout_seconds=1.0))
    assert response.finish_reason is FinishReason.STOP
    assert harness.gateway.received == [pytest.approx(0.6)]
    events = asyncio.run(_drain(harness.context.stream(_invocation("hi"), timeout_seconds=1.0)))
    assert [type(event).__name__ for event in events][-1] == "CompletionFinished"
    assert harness.gateway.received == [pytest.approx(0.6), pytest.approx(0.6)]
    assert harness.provider_calls == 2


def test_default_gateway_timeout_applies_when_the_caller_gives_none() -> None:
    harness = Harness(step=1.0, gateway_timeout=10.0)
    asyncio.run(harness.context.complete(_invocation("hi")))
    assert harness.gateway.received == [pytest.approx(8.0)]
    asyncio.run(_drain(harness.context.stream(_invocation("hi"))))
    assert harness.gateway.received[-1] == pytest.approx(8.0)


def test_a_caller_timeout_cannot_exceed_the_gateway_maximum() -> None:
    harness = Harness(step=1.0, gateway_timeout=10.0)
    asyncio.run(harness.context.complete(_invocation("hi"), timeout_seconds=100))
    assert harness.gateway.received == [pytest.approx(8.0)]  # 10 (capped) - 2, never 98
    asyncio.run(harness.context.complete(_invocation("hi"), timeout_seconds=5))
    assert harness.gateway.received[-1] == pytest.approx(3.0)


@pytest.mark.parametrize("invalid", [0, -1, -0.5, True, "5"])
def test_invalid_timeouts_keep_the_existing_error_and_skip_preparation(invalid: object) -> None:
    harness = Harness(step=0.1)
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(harness.context.complete(_invocation("hi"), timeout_seconds=invalid))  # type: ignore[arg-type]
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(_drain(harness.context.stream(_invocation("hi"), timeout_seconds=invalid)))  # type: ignore[arg-type]
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(harness.prompts.complete(_prompt(), timeout_seconds=invalid))  # type: ignore[arg-type]
    assert harness.estimator.calls == 0 and harness.provider_calls == 0


def test_validation_errors_still_win_over_the_deadline_check() -> None:
    harness = Harness(step=0.0)
    with pytest.raises(PromptPolicyViolationError):
        asyncio.run(harness.context.complete(_invocation("hi", variables=(("organization", "x"),))))
    assert harness.provider_calls == 0


# --- PromptService had the same defect ---------------------------------------------------------


def test_prompt_service_counts_preparation_against_the_same_budget() -> None:
    whole = Harness(step=1.0)
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(whole.prompts.complete(_prompt(), timeout_seconds=1.0))
    with pytest.raises(RequestDeadlineExceededError):
        asyncio.run(_drain(whole.prompts.stream(_prompt(), timeout_seconds=1.0)))
    assert whole.provider_calls == 0 and whole.gateway.received == []

    part = Harness(step=0.25, gateway_timeout=10.0)
    asyncio.run(part.prompts.complete(_prompt(), timeout_seconds=2.0))
    asyncio.run(_drain(part.prompts.stream(_prompt())))
    assert part.gateway.received == [pytest.approx(1.75), pytest.approx(9.75)]


def test_prompt_service_stays_backward_compatible_without_a_timeout() -> None:
    harness = Harness(step=0.0)
    response = asyncio.run(harness.prompts.complete(_prompt()))
    assert response.finish_reason is FinishReason.STOP
    assert harness.gateway.received == [pytest.approx(300.0)]


# --- queueing, cancellation and capacity under the shared budget (real asyncio time) -----------


def test_queue_waiting_is_bounded_by_the_budget_and_does_not_reset_it() -> None:
    async def scenario() -> None:
        hold = asyncio.Event()
        harness = Harness(hold=hold)
        first = asyncio.create_task(harness.context.complete(_invocation("one")))
        await asyncio.sleep(0.05)
        started = time.monotonic()
        with pytest.raises(RequestDeadlineExceededError):
            await harness.context.complete(_invocation("two"), timeout_seconds=0.15)
        assert (
            time.monotonic() - started < 2.0
        )  # bounded by its own budget, not the 30 s admission wait
        assert harness.provider_calls == 1  # the queued request never reached the provider
        hold.set()
        assert (await first).finish_reason is FinishReason.STOP

    asyncio.run(scenario())


def test_overload_cancellation_and_capacity_recovery_still_hold() -> None:
    async def scenario() -> None:
        hold = asyncio.Event()
        harness = Harness(hold=hold)
        first = asyncio.create_task(
            harness.context.complete(_invocation("one"), timeout_seconds=30)
        )
        await asyncio.sleep(0.05)
        second = asyncio.create_task(
            harness.context.complete(_invocation("two"), timeout_seconds=30)
        )
        await asyncio.sleep(0.05)
        with pytest.raises(ProviderOverloadError):
            await harness.context.complete(_invocation("three"), timeout_seconds=30)
        for task in (first, second):
            task.cancel()
        results = await asyncio.gather(first, second, return_exceptions=True)
        assert all(isinstance(result, asyncio.CancelledError) for result in results)
        harness.hold = None
        assert (
            await harness.context.complete(_invocation("again"))
        ).finish_reason is FinishReason.STOP
        assert harness.provider_calls == 2

    asyncio.run(scenario())


def test_an_expired_provider_call_releases_capacity_for_the_next_request() -> None:
    async def scenario() -> None:
        harness = Harness(hold=asyncio.Event())  # the provider never answers
        with pytest.raises(RequestDeadlineExceededError):
            await harness.context.complete(_invocation("slow"), timeout_seconds=0.1)
        harness.hold = None
        assert (
            await harness.context.complete(_invocation("next"))
        ).finish_reason is FinishReason.STOP

    asyncio.run(scenario())
