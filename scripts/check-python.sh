#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python_executable="${repository_root}/.venv/bin/python"
service_directory="${repository_root}/apps/ai-service"

if [[ ! -x "${python_executable}" ]]; then
  echo "Python virtual environment not found at ${python_executable}" >&2
  exit 1
fi

cd "${service_directory}"
"${python_executable}" -m ruff check .
"${python_executable}" -m ruff format --check .
"${python_executable}" -m mypy src tests
"${python_executable}" -m pytest
