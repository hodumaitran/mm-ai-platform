import ast
from pathlib import Path

SOURCE_ROOT = Path(__file__).parents[1] / "src" / "mm_ai_service"


def _imports_in(layer: str) -> set[str]:
    imports: set[str] = set()
    for source_file in (SOURCE_ROOT / layer).rglob("*.py"):
        tree = ast.parse(source_file.read_text(encoding="utf-8"), filename=str(source_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module)
    return imports


def _assert_no_import_prefix(layer: str, forbidden: tuple[str, ...]) -> None:
    violations = sorted(
        imported
        for imported in _imports_in(layer)
        if any(imported == name or imported.startswith(f"{name}.") for name in forbidden)
    )
    assert violations == []


def test_domain_has_no_outward_or_framework_dependencies() -> None:
    _assert_no_import_prefix(
        "domain",
        (
            "fastapi",
            "starlette",
            "httpx",
            "requests",
            "ollama",
            "vllm",
            "mm_ai_service.application",
            "mm_ai_service.infrastructure",
            "mm_ai_service.presentation",
        ),
    )


def test_application_has_no_framework_or_outer_layer_dependencies() -> None:
    _assert_no_import_prefix(
        "application",
        (
            "fastapi",
            "starlette",
            "httpx",
            "requests",
            "ollama",
            "vllm",
            "mm_ai_service.infrastructure",
            "mm_ai_service.presentation",
        ),
    )


def test_infrastructure_does_not_depend_on_presentation() -> None:
    _assert_no_import_prefix("infrastructure", ("mm_ai_service.presentation",))
