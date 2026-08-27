param (
    [string]$ApiBaseUrl = "https://dmlllpvfenxzw7-8000.proxy.runpod.net",
    [double]$TargetBpm = 124.0,
    [string]$TargetKey = "D Minor",
    [int]$PollSeconds = 90
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not (Test-Path (Join-Path $root ".env.local"))) {
    $root = Get-Location
}

function Import-DotEnv([string]$Path) {
    if (-not (Test-Path $Path)) { return }
    Get-Content -Path $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
        $name, $value = $line.Split("=", 2)
        $name = $name.Trim()
        $value = $value.Trim().Trim('"').Trim("'")
        if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
            [Environment]::SetEnvironmentVariable($name, $value, "Process")
        }
    }
}

Import-DotEnv (Join-Path $root ".env.local")
Import-DotEnv (Join-Path $root ".env")

$supabaseUrl = ($env:SUPABASE_URL)
if (-not $supabaseUrl) { $supabaseUrl = $env:NEXT_PUBLIC_SUPABASE_URL }
if (-not $supabaseUrl) { $supabaseUrl = $env:VITE_SUPABASE_URL }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$key = $env:SUPABASE_SERVICE_ROLE_KEY

Write-Host "=== 1. fma_tracks REST ===" -ForegroundColor Cyan
if (-not $supabaseUrl -or -not $key) {
    Write-Host "SKIP: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set"
} else {
    $headers = @{
        apikey        = $key
        Authorization = "Bearer $key"
        Prefer        = "count=exact"
    }
    try {
        $resp = Invoke-WebRequest -Uri "$supabaseUrl/rest/v1/fma_tracks?select=track_id" -Headers $headers -UseBasicParsing
        Write-Host "HTTP $($resp.StatusCode) Content-Range=$($resp.Headers['Content-Range'])"
    } catch {
        Write-Host "FAIL: $($_.Exception.Message)"
    }
}

Write-Host "`n=== 2. POST /api/v2/auto-generate ===" -ForegroundColor Cyan
$body = @{ target_bpm = $TargetBpm; target_key = $TargetKey } | ConvertTo-Json
$jobId = $null
try {
    $queued = Invoke-RestMethod -Uri "$ApiBaseUrl/api/v2/auto-generate" -Method Post -ContentType "application/json" -Body $body
    $jobId = $queued.job_id
    Write-Host "job_id=$jobId status=$($queued.status) layers=$($queued.recipe.layers.Count)"
} catch {
    Write-Host "FAIL: $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    exit 1
}

if (-not $jobId) { exit 1 }

Write-Host "`n=== 3. Poll /api/v2/render/$jobId ===" -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($PollSeconds)
do {
    $status = Invoke-RestMethod -Uri "$ApiBaseUrl/api/v2/render/$jobId" -Method Get
    Write-Host "Current Status: $($status.status)"
    if ($status.status -in @("completed", "SUCCESS", "failed", "FAILURE")) { break }
    Start-Sleep -Seconds 3
} while ((Get-Date) -lt $deadline)

Write-Host "final_status=$($status.status) r2_key=$($status.r2_key) has_download_url=$([bool]$status.download_url)"
if ($status.status -in @("failed", "FAILURE")) { exit 1 }
