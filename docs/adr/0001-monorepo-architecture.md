# ADR 0001: Polyglot monorepo architecture

- Status: Accepted
- Date: 2026-11-20

## Context

The platform needs coordinated web, business, and AI services with independent Python and JavaScript
dependency lifecycles.

## Decision

Use pnpm/Turborepo for Next.js and NestJS. Keep FastAPI in the repository but manage it with
`pyproject.toml` and `.venv`. Invoke Python gates through a Windows-compatible PowerShell script rather
than representing Python as a fake pnpm package.

## Consequences

The repository has one review surface. CI explicitly runs both toolchains. Cross-service reuse happens
through contracts, not source-level imports.
