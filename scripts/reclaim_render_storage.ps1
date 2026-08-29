# D:\MusicDatasets\scripts\reclaim_render_storage.ps1
param(
    [string]$BaseDir = "D:\MusicDatasets",
    [int]$MinAgeHours = 12,
    [switch]$DryRun = $false
)

$ErrorActionPreference = "Continue"

$RendersDir = Join-Path $BaseDir "renders"
$TelemetryScript = Join-Path "$BaseDir\scripts" "log_telemetry.py"

$sbUrl = $env:SUPABASE_URL
$sbKey = $env:SUPABASE_SERVICE_ROLE_KEY

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - AUTOMATED STORAGE RECLAMATION ENGINE" -ForegroundColor Cyan
Write-Host "Target Directory : $RendersDir"
Write-Host "Age Threshold    : $MinAgeHours hours"
Write-Host "Execution Mode   : $(if ($DryRun) { '[DRY RUN - NO DELETIONS]' } else { '[LIVE PURGE]' })"
Write-Host "================================================================" -ForegroundColor Cyan

if (!(Test-Path $RendersDir)) {
    Write-Host "[INFO] No renders directory found at $RendersDir. Nothing to reclaim."
    exit 0
}

$Headers = @{
    "apikey"        = $sbKey
    "Authorization" = "Bearer $sbKey"
    "Content-Type"  = "application/json"
}

$CutoffTime = (Get-Date).AddHours(-$MinAgeHours)
$RenderDirs = Get-ChildItem -Path $RendersDir -Directory

$TotalReclaimedBytes = 0
$PurgedCount = 0
$SkippedCount = 0

foreach ($dir in $RenderDirs) {
    $sessionId = $dir.Name
    $dirAge = $dir.LastWriteTime

    # 1. Query Supabase ledger for session state
    $isEligible = $false
    $reason = ""

    if ($sbUrl -and $sbKey) {
        try {
            $endpoint = "$sbUrl/rest/v1/user_vaults?session_id=eq.$sessionId&select=status,storage_url"
            $response = Invoke-RestMethod -Uri $endpoint -Headers $Headers -Method Get -TimeoutSec 10

            if ($response -and $response.Count -gt 0) {
                $session = $response[0]
                $status = $session.status

                if ($status -eq "completed" -and $session.storage_url) {
                    $isEligible = $true
                    $reason = "Status: completed (Cloud master verified)"
                } elseif ($status -eq "completed" -and -not $session.storage_url) {
                    $isEligible = $false
                    $reason = "Status: completed but storage_url missing (retaining local master)"
                } elseif ($status -eq "failed" -and $dirAge -lt $CutoffTime) {
                    $isEligible = $true
                    $reason = "Status: failed (Exceeded $MinAgeHours hr retention window)"
                } elseif ($status -eq "processing" -or $status -eq "pending") {
                    $isEligible = $false
                    $reason = "Status: $status (Active pipeline job)"
                } else {
                    $isEligible = $false
                    $reason = "Status: $status (within retention window)"
                }
            } else {
                # Orphaned directory not in DB
                if ($dirAge -lt $CutoffTime) {
                    $isEligible = $true
                    $reason = "Orphaned directory older than $MinAgeHours hours"
                } else {
                    $isEligible = $false
                    $reason = "Unindexed directory within age window"
                }
            }
        } catch {
            Write-Host "  -> [WARN] Supabase query failed for $sessionId : $($_.Exception.Message)" -ForegroundColor Yellow
            $isEligible = ($dirAge -lt $CutoffTime)
            $reason = "Fallback age cutoff ($MinAgeHours hrs)"
        }
    } else {
        # Offline mode fallback based on age
        $isEligible = ($dirAge -lt $CutoffTime)
        $reason = "Age cutoff fallback ($MinAgeHours hrs)"
    }

    # 2. Calculate directory size
    $dirSize = (Get-ChildItem -Path $dir.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    if (-not $dirSize) { $dirSize = 0 }
    $dirSizeMb = [math]::Round($dirSize / 1MB, 2)

    # 3. Purge or skip
    if ($isEligible) {
        Write-Host "  [PURGE] $sessionId ($dirSizeMb MB) - $reason" -ForegroundColor Yellow
        if (-not $DryRun) {
            Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        $TotalReclaimedBytes += $dirSize
        $PurgedCount++
    } else {
        Write-Host "  [SKIP]  $sessionId ($dirSizeMb MB) - $reason" -ForegroundColor Gray
        $SkippedCount++
    }
}

$TotalReclaimedGb = [math]::Round($TotalReclaimedBytes / 1GB, 2)
$TotalReclaimedMb = [math]::Round($TotalReclaimedBytes / 1MB, 2)

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "RECLAMATION SUMMARY:" -ForegroundColor Green
Write-Host "  Directories Purged  : $PurgedCount"
Write-Host "  Directories Retained: $SkippedCount"
Write-Host "  Storage Freed       : $TotalReclaimedMb MB ($TotalReclaimedGb GB)"
Write-Host "================================================================" -ForegroundColor Cyan

# 4. Telemetry Logging
if (-not $DryRun -and (Test-Path $TelemetryScript) -and $PurgedCount -gt 0) {
    $metaJson = "{`"purged_directories`":$PurgedCount,`"reclaimed_mb`":$TotalReclaimedMb,`"reclaimed_gb`":$TotalReclaimedGb}"
    python $TelemetryScript --event "storage_reclaimed" --user "00000000-0000-0000-0000-000000000001" --duration 0 --metadata $metaJson
}
