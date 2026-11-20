# Repository structure

```text
apps/
  web/          Next.js user interface
  api/          NestJS business API
  ai-service/   Independent Python/FastAPI service
docs/
  adr/          Architecture decision records
  architecture/ System design and boundaries
  checkpoints/  Acceptance records
  security/     Security controls
scripts/        Cross-toolchain automation
```

`packages/`, `infrastructure/`, `benchmarks/`, and broad integration suites will be added only when a
checkpoint introduces real shared code or deployable infrastructure. Empty placeholder packages are
intentionally omitted.
