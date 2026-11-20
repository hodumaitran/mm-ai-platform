#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_executable="${repository_root}/.venv/bin/python"
requirements_lock="${repository_root}/apps/ai-service/requirements.lock"
audit_cache="${TMPDIR:-/tmp}/mm-ai-platform-pip-audit-cache"

if [[ ! -x "${python_executable}" ]]; then
  echo "Python virtual environment not found at ${python_executable}" >&2
  exit 1
fi

"${python_executable}" -m pip_audit --requirement "${requirements_lock}" --no-deps --disable-pip --cache-dir "${audit_cache}"
