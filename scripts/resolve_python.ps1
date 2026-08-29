<#
.SYNOPSIS
    Resolves a real CPython interpreter, never the Microsoft Store alias stub.
.DESCRIPTION
    Dot-source this file to get Get-HybridPython.

    `Get-Command python` on Windows frequently resolves to
    %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe, an App Execution Alias that
    is not an interpreter - it opens the Store instead. Any NSSM service
    registered against that path installs successfully and then dies on start,
    and any Test-Path style health check reports a false pass.

    Resolution order:
      1. $env:HYBRID_PYTHON, if set and valid
      2. Known install roots, highest version first
      3. PATH lookup, with WindowsApps stubs rejected

    Every candidate is verified by actually invoking `--version`.
.EXAMPLE
    . "$PSScriptRoot\resolve_python.ps1"
    $python = Get-HybridPython
#>

function Test-RealPython {
    param([string]$Path)

    if (-not $Path) { return $false }
    if (-not (Test-Path $Path)) { return $false }

    # App Execution Alias stubs live under WindowsApps and are zero-length reparse points
    if ($Path -like "*\WindowsApps\*") { return $false }

    try {
        $output = & $Path --version 2>&1
        return ($LASTEXITCODE -eq 0 -and $output -match "^Python\s+3\.")
    } catch {
        return $false
    }
}

function Get-HybridPython {
    param(
        [switch]$Quiet
    )

    # 1. Explicit override
    if ($env:HYBRID_PYTHON -and (Test-RealPython -Path $env:HYBRID_PYTHON)) {
        if (-not $Quiet) { Write-Host "  -> Python resolved from HYBRID_PYTHON: $($env:HYBRID_PYTHON)" -ForegroundColor Gray }
        return $env:HYBRID_PYTHON
    }

    # 2. Known install roots, newest version first
    $searchRoots = @(
        "$env:LOCALAPPDATA\Programs\Python",
        "$env:ProgramFiles\Python",
        "${env:ProgramFiles(x86)}\Python",
        "C:\"
    )

    $candidates = @()

    foreach ($root in $searchRoots) {
        if (-not (Test-Path $root)) { continue }
        $candidates += Get-ChildItem -Path $root -Directory -Filter "Python3*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName "python.exe" }
    }

    foreach ($candidate in $candidates) {
        if (Test-RealPython -Path $candidate) {
            if (-not $Quiet) { Write-Host "  -> Python resolved: $candidate" -ForegroundColor Gray }
            return $candidate
        }
    }

    # 3. PATH lookup, stubs excluded
    foreach ($name in @("python", "python3")) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and (Test-RealPython -Path $cmd.Source)) {
            if (-not $Quiet) { Write-Host "  -> Python resolved from PATH: $($cmd.Source)" -ForegroundColor Gray }
            return $cmd.Source
        }
    }

    return $null
}

function Assert-HybridPython {
    $python = Get-HybridPython

    if (-not $python) {
        Write-Host "[ERROR] No usable Python 3 interpreter found." -ForegroundColor Red
        Write-Host "        'python' on PATH currently resolves to:" -ForegroundColor Yellow
        $stub = (Get-Command python -ErrorAction SilentlyContinue).Source
        Write-Host "          $(if ($stub) { $stub } else { '<nothing>' })" -ForegroundColor Yellow
        Write-Host "        If that path contains \WindowsApps\ it is the Microsoft Store alias," -ForegroundColor Yellow
        Write-Host "        not an interpreter. Install Python 3.12 or set HYBRID_PYTHON to its" -ForegroundColor Yellow
        Write-Host "        full python.exe path." -ForegroundColor Yellow
        throw "Python interpreter not resolvable."
    }

    return $python
}
