$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$pythonExecutable = Join-Path $repositoryRoot '.venv\Scripts\python.exe'
$serviceDirectory = Join-Path $repositoryRoot 'apps\ai-service'

if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw "Python virtual environment not found at $pythonExecutable"
}

Push-Location $serviceDirectory
try {
    & $pythonExecutable -m ruff check .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $pythonExecutable -m ruff format --check .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $pythonExecutable -m mypy src tests
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $pythonExecutable -m pytest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
