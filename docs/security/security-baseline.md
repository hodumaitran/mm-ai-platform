# Security baseline

## Current controls

- Development listeners bind to loopback by default.
- Runtime configuration is validated and secrets are excluded from Git.
- Health responses expose no secrets, model details, or exception internals.
- Browser code has no provider access; provider integration is deferred behind the AI service.
- Private data, uploads, databases, caches, logs, and model weights are ignored by path/type.

## Required future controls

Before production use, add least-privilege RBAC, audit logs with redaction, encryption/key management,
document malware/content checks, retention policy, rate limiting, CORS/CSRF policy, dependency scanning,
SBOM generation, and tested backup/restore.

Never place secrets in `NEXT_PUBLIC_*` variables. Logs must not include prompts, document content,
tokens, credentials, or personal information by default.
