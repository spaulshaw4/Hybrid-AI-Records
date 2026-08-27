param (
    [string]$SupabaseUrl = $env:SUPABASE_URL,
    [string]$SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY,
    [string]$ApiBaseUrl = $(if ($env:API_BASE_URL) { $env:API_BASE_URL } else { "http://localhost:8000" }),
    [int]$IntervalSec = 10
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
        $name, $value = $line.Split("=", 2)
        $name = $name.Trim()
        $value = $value.Trim().Trim('"').Trim("'")
        if ($name -and -not [Environment]::GetEnvironmentVariable($name)) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-DotEnv (Join-Path $root ".env.local")
Import-DotEnv (Join-Path $root ".env")

if (-not $SupabaseUrl) {
    $SupabaseUrl = $env:SUPABASE_URL
    if (-not $SupabaseUrl) { $SupabaseUrl = $env:NEXT_PUBLIC_SUPABASE_URL }
    if (-not $SupabaseUrl) { $SupabaseUrl = $env:VITE_SUPABASE_URL }
}
if (-not $SupabaseKey) { $SupabaseKey = $env:SUPABASE_SERVICE_ROLE_KEY }
$SupabaseUrl = ($SupabaseUrl | ForEach-Object { $_.TrimEnd("/") })

if (-not $SupabaseUrl -or -not $SupabaseKey) {
    Write-Error "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or put them in .env.local."
    exit 1
}

$headers = @{
    "apikey"         = $SupabaseKey
    "Authorization"  = "Bearer $SupabaseKey"
    "Prefer"         = "count=exact"
    "Range-Unit"     = "items"
    "Range"          = "0-0"
}

Write-Host "--- Remote Stem Ingestion & Engine Monitor ---" -ForegroundColor Cyan
Write-Host "Polling fma_tracks every $IntervalSec seconds. API: $ApiBaseUrl"

$previousCount = -1
while ($true) {
    try {
        $response = Invoke-WebRequest -Uri "$SupabaseUrl/rest/v1/fma_tracks?select=track_id" `
            -Method Get `
            -Headers $headers `
            -UseBasicParsing

        $totalTracks = 0
        $contentRange = $response.Headers["Content-Range"]
        if ($contentRange -match "/(\d+|\*)") {
            if ($Matches[1] -ne "*") { $totalTracks = [int]$Matches[1] }
        }

        $apiStatus = "UNREACHABLE"
        try {
            Invoke-RestMethod -Uri "$ApiBaseUrl/health" -Method Get -TimeoutSec 3 | Out-Null
            $apiStatus = "ONLINE"
        } catch {
            try {
                Invoke-WebRequest -Uri "$ApiBaseUrl/docs" -Method Get -TimeoutSec 3 -UseBasicParsing | Out-Null
                $apiStatus = "ONLINE"
            } catch {
                $apiStatus = "UNREACHABLE"
            }
        }

        $delta = 0
        if ($previousCount -ge 0) { $delta = $totalTracks - $previousCount }
        $previousCount = $totalTracks
        $timestamp = Get-Date -Format "HH:mm:ss"
        Write-Host "[$timestamp] Indexed Tracks: $totalTracks (+$delta in last ${IntervalSec}s) | Engine API: $apiStatus" -ForegroundColor Green
    } catch {
        Write-Host "[ERROR] Polling failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    Start-Sleep -Seconds $IntervalSec
}
