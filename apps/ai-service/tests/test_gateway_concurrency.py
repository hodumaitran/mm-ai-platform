import asyncio

import pytest

from mm_ai_service.application.gateway import GatewayPolicy, LLMGateway
from mm_ai_service.application.registry import ProviderRegistry
from mm_ai_service.domain.errors import ProviderConnectionError, ProviderTimeoutError
from mm_ai_service.domain.llm import ChatMessage, CompletionRequest, MessageRole
from tests.fakes import FakeProvider, empty_stream, response_for


def _request() -> CompletionRequest:
    return CompletionRequest("model", (ChatMessage(MessageRole.USER, "prompt"),))


def _gateway(provider: FakeProvider, *, timeout: float = 1) -> LLMGateway:
    return LLMGateway(
        ProviderRegistry((provider,), "fake"),
        GatewayPolicy(max_concurrency=1, request_timeout_seconds=timeout),
    )


def test_concurrency_limit_prevents_parallel_provider_calls() -> None:
    async def exercise() -> tuple[int, int]:
        active = 0
        maximum = 0
        calls = 0
        entered = asyncio.Event()
        release = asyncio.Event()

        async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
            nonlocal active, maximum, calls
            calls += 1
            active += 1
            maximum = max(maximum, active)
            entered.set()
            try:
                await release.wait()
                return response_for(request)
            finally:
                active -= 1

        gateway = _gateway(FakeProvider(complete, empty_stream))
        first = asyncio.create_task(gateway.complete(_request()))
        await entered.wait()
        second = asyncio.create_task(gateway.complete(_request()))
        await asyncio.sleep(0.01)
        assert calls == 1
        release.set()
        await asyncio.gather(first, second)
        return maximum, calls

    assert asyncio.run(exercise()) == (1, 2)


def test_queue_waiting_is_covered_by_end_to_end_timeout() -> None:
    async def exercise() -> tuple[list[object], int]:
        calls = 0
        entered = asyncio.Event()
        never = asyncio.Event()

        async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1
            entered.set()
            try:
                await never.wait()
                return response_for(request)
            except asyncio.CancelledError:
                await asyncio.sleep(0.05)
                raise

        gateway = _gateway(FakeProvider(complete, empty_stream), timeout=0.03)
        first = asyncio.create_task(gateway.complete(_request()))
        await entered.wait()
        second = asyncio.create_task(gateway.complete(_request()))
        results = await asyncio.gather(first, second, return_exceptions=True)
        return list(results), calls

    results, calls = asyncio.run(exercise())
    assert all(isinstance(result, ProviderTimeoutError) for result in results)
    assert calls == 1


def test_semaphore_is_released_after_provider_failure() -> None:
    async def exercise() -> str:
        calls = 0

        async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ProviderConnectionError()
            return response_for(request)

        gateway = _gateway(FakeProvider(complete, empty_stream))
        with pytest.raises(ProviderConnectionError):
            await gateway.complete(_request())
        return (await gateway.complete(_request())).message.content

    assert asyncio.run(exercise()) == "response"


def test_cancellation_propagates_and_releases_semaphore() -> None:
    async def exercise() -> tuple[bool, str]:
        calls = 0
        entered = asyncio.Event()
        cancelled = False

        async def complete(request: CompletionRequest):  # type: ignore[no-untyped-def]
            nonlocal calls, cancelled
            calls += 1
            if calls == 1:
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled = True
            return response_for(request)

        gateway = _gateway(FakeProvider(complete, empty_stream))
        first = asyncio.create_task(gateway.complete(_request()))
        await entered.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        second = await gateway.complete(_request())
        return cancelled, second.message.content

    assert asyncio.run(exercise()) == (True, "response")
