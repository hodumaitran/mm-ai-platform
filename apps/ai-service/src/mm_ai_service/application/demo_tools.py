"""Deterministic, side-effect-free demonstration tools.

They touch no filesystem, network, process, database or interpreter, and use no ``eval``/``exec``.
"""

from collections.abc import Mapping

from mm_ai_service.application.tools import ToolRegistry
from mm_ai_service.domain.tools import (
    JsonScalar,
    ParameterType,
    ToolDefinition,
    ToolParameter,
)

OPERAND_LIMIT = 1_000_000

CALCULATE = ToolDefinition(
    name="calculate",
    description="Bounded arithmetic on two numbers: add, subtract, multiply or divide.",
    parameters=(
        ToolParameter(
            "operation",
            ParameterType.STRING,
            "Arithmetic operation to apply.",
            max_length=16,
            allowed_values=("add", "subtract", "multiply", "divide"),
        ),
        ToolParameter(
            "left",
            ParameterType.NUMBER,
            "Left operand.",
            minimum=-OPERAND_LIMIT,
            maximum=OPERAND_LIMIT,
        ),
        ToolParameter(
            "right",
            ParameterType.NUMBER,
            "Right operand.",
            minimum=-OPERAND_LIMIT,
            maximum=OPERAND_LIMIT,
        ),
    ),
)

TEXT_STATISTICS = ToolDefinition(
    name="text_statistics",
    description="Counts characters, words, lines and UTF-8 bytes of a short text.",
    parameters=(ToolParameter("text", ParameterType.STRING, "Text to measure.", max_length=2000),),
)


async def _calculate(arguments: Mapping[str, JsonScalar]) -> object:
    operation = arguments["operation"]
    left = arguments["left"]
    right = arguments["right"]
    assert isinstance(left, (int, float)) and isinstance(right, (int, float))
    if operation == "add":
        result = left + right
    elif operation == "subtract":
        result = left - right
    elif operation == "multiply":
        result = left * right
    else:
        result = left / right  # ZeroDivisionError is sanitized by the executor
    return {"operation": operation, "result": result}


async def _text_statistics(arguments: Mapping[str, JsonScalar]) -> object:
    text = arguments["text"]
    assert isinstance(text, str)
    return {
        "characters": len(text),
        "words": len(text.split()),
        "lines": len(text.splitlines()),
        "utf8_bytes": len(text.encode("utf-8")),
    }


def build_demo_registry() -> ToolRegistry:
    """Return a sealed registry with the demonstration tools (not wired into the service)."""
    registry = ToolRegistry()
    registry.register(CALCULATE, _calculate)
    registry.register(TEXT_STATISTICS, _text_statistics)
    registry.seal()
    return registry
