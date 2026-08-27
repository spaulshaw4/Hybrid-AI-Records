# Avoids PowerShell curl JSON mangling. Uses ConvertTo-Json.
param (
    [string]$ApiBaseUrl = $(if ($env:API_BASE_URL) { $env:API_BASE_URL } else { "http://localhost:8000" }),
    [double]$TargetBpm = 124.0,
    [string]$TargetKey = "D Minor"
)

$body = @{
    target_bpm = $TargetBpm
    target_key = $TargetKey
} | ConvertTo-Json

Write-Host "POST $ApiBaseUrl/api/v2/auto-generate"
Invoke-RestMethod -Uri "$ApiBaseUrl/api/v2/auto-generate" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body | Format-List
