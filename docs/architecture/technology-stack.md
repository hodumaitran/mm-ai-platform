# Technology stack

| Layer            | Technology                           | Rationale                                           |
| ---------------- | ------------------------------------ | --------------------------------------------------- |
| Workspace        | pnpm 10 + Turborepo                  | Deterministic JS graph and task orchestration       |
| Web              | Next.js 16, React 19, Tailwind CSS 4 | App Router and typed UI foundation                  |
| Business API     | NestJS 11                            | Modular TypeScript services and validation patterns |
| AI service       | Python 3.13, FastAPI, Pydantic       | Typed, provider-neutral AI boundary                 |
| Python quality   | Ruff, mypy, pytest                   | Lint/format, strict typing, tests                   |
| Initial provider | Ollama + Qwen3.5 (future adapter)    | Private inference; not integrated in 2.1            |

Dependencies are pinned in manifests and lockfiles. Python is managed outside pnpm to avoid coupling
language toolchains.
