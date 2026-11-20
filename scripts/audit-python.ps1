$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$pythonExecutable = Join-Path $repositoryRoot '.venv\Scripts\python.exe'
$requirementsLock = Join-Path $repositoryRoot 'apps\ai-service\requirements.lock'
$auditCache = Join-Path ([System.IO.Path]::GetTempPath()) 'mm-ai-platform-pip-audit-cache'

if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw "Python virtual environment not found at $pythonExecutable"
}

& $pythonExecutable -m pip_audit --requirement $requirementsLock --no-deps --disable-pip --cache-dir $auditCache
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
