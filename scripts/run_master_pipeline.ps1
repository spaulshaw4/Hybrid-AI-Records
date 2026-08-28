<#
.SYNOPSIS
    Hybrid 1.0 - Master Generation Pipeline (PowerShell Edition)
.DESCRIPTION
    Executes the complete audio pipeline with advanced error trapping, 
    live stream logging to the D: drive, and automated egress stem purging.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$SessionId
)

# Enforce strict error handling
$ErrorActionPreference = "Stop"

# Configuration
$Env:SUPABASE_URL = "your_project_url_here"
$Env:SUPABASE_SERVICE_ROLE_KEY = "your_service_key_here"

$ScriptDir = "D:\MusicDatasets\scripts"
$LogDir = "D:\MusicDatasets\logs"

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFile = Join-Path $LogDir "pipeline_run_$Timestamp.log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $LogLine = "[$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] [$Level] $Message"
    Write-Host $LogLine
    Add-Content -Path $LogFile -Value $LogLine
}

try {
    Write-Log "=============================================================================="
    Write-Log "INITIATING HYBRID 1.0 MASTER GENERATION PIPELINE"
    Write-Log "=============================================================================="

    # Prompt for Session ID if not provided via argument
    if (-not $SessionId) {
        $SessionId = Read-Host "Enter Session ID"
    }

    if (-not $SessionId) {
        throw "Session ID cannot be empty."
    }

    $WorkDir = "D:\MusicDatasets\renders\$SessionId"

    Write-Log "Target Session ID: $SessionId"
    Write-Log "Working Directory: $WorkDir"
    Write-Log "Log Output: $LogFile"

    # Step 1: Cylinder Orchestrator
    Write-Log "[1/4] Running Cylinder Orchestrator..."
    python "$ScriptDir\cylinder_orchestrator.py" --session "$SessionId" 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) { throw "Cylinder Orchestrator failed with exit code $LASTEXITCODE" }

    # Step 2: Bus Summation
    Write-Log "[2/4] Running Bus Summation Engine..."
    python "$ScriptDir\cylinder_bus_summation.py" --session "$SessionId" --dir "$WorkDir" 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) { throw "Bus Summation failed with exit code $LASTEXITCODE" }

    # Step 3: Cryptographic Hex Hook
    Write-Log "[3/4] Executing Hex Pipeline Hook..."
    python "$ScriptDir\hybrid_hex_pipeline_hook.py" --session "$SessionId" --dir "$WorkDir" 2>&1 | Tee-Object -FilePath $LogFile -Append
    if ($LASTEXITCODE -ne 0) { throw "Cryptographic Hex Hook failed with exit code $LASTEXITCODE" }

    # Step 4: Purge Temporary Stems (Egress Protection)
    Write-Log "[4/4] Purging temporary raw stems to protect cloud egress..."
    $RawStemsDir = Join-Path $WorkDir "raw_stems"

    if (Test-Path $RawStemsDir) {
        Remove-Item -Path $RawStemsDir -Recurse -Force
        Write-Log "Temporary stems wiped successfully from $RawStemsDir"
    } else {
        Write-Log "No temporary stems directory found to purge." "WARNING"
    }

    Write-Log "=============================================================================="
    Write-Log "PIPELINE COMPLETED SUCCESSFULLY FOR SESSION: $SessionId" "SUCCESS"
    Write-Log "=============================================================================="

} catch {
    Write-Log "CRITICAL ERROR: $_" "ERROR"
    Write-Log "Pipeline failed during execution. Review log file for details: $LogFile" "ERROR"
    exit 1
}
