# D:\MusicDatasets\scripts\manage_alert_silences.ps1
param(
    [ValidateSet("ListAlerts", "ListSilences", "CreateSilence", "ExpireSilence")]
    [string]$Action = "ListAlerts",
    [string]$AlertmanagerUrl = "http://127.0.0.1:9093",
    [string]$MatcherKey = "alertname",
    [string]$MatcherValue = "",
    [int]$DurationHours = 2,
    [string]$Author = "HybridAdmin",
    [string]$Comment = "Scheduled workstation maintenance window",
    [string]$SilenceId = ""
)

$ErrorActionPreference = "Stop"

function Get-Alerts {
    $uri = "$AlertmanagerUrl/api/v2/alerts"
    $alerts = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10

    if (-not $alerts -or $alerts.Count -eq 0) {
        Write-Host "[INFO] No active alerts found on Alertmanager." -ForegroundColor Green
        return
    }

    Write-Host "`nACTIVE ALERTS ($($alerts.Count)):" -ForegroundColor Yellow

    $tableData = $alerts | ForEach-Object {
        [PSCustomObject]@{
            AlertName   = $_.labels.alertname
            Severity    = $_.labels.severity
            Target      = $_.labels.target
            State       = $_.status.state
            SilencedBy  = if ($_.status.silencedBy -and $_.status.silencedBy.Count -gt 0) { $_.status.silencedBy -join ", " } else { "None" }
            StartsAt    = $_.startsAt
            Summary     = $_.annotations.summary
        }
    }

    $tableData | Format-Table -AutoSize
}

function Get-Silences {
    $uri = "$AlertmanagerUrl/api/v2/silences"
    $silences = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 10

    if (-not $silences -or $silences.Count -eq 0) {
        Write-Host "[INFO] No active or past silences recorded." -ForegroundColor Gray
        return
    }

    $activeSilences = @($silences | Where-Object { $_.status.state -eq "active" })

    # Expired entries are listed too, since their IDs are still useful for audit.
    Write-Host "`nSILENCES - $($silences.Count) total, $($activeSilences.Count) currently active:" -ForegroundColor Cyan

    $tableData = $silences | ForEach-Object {
        $matcherSummary = ($_.matchers | ForEach-Object { "$($_.name)=$($_.value)" }) -join " & "
        [PSCustomObject]@{
            SilenceID = $_.id
            State     = $_.status.state
            Matchers  = $matcherSummary
            CreatedBy = $_.createdBy
            EndsAt    = $_.endsAt
            Comment   = $_.comment
        }
    }

    $tableData | Format-Table -AutoSize
}

function New-Silence {
    if (-not $MatcherValue) {
        throw "MatcherValue is required when creating a silence. Example: -MatcherValue 'DriveDCriticalStorageExhaustion'"
    }

    $now = (Get-Date).ToUniversalTime()
    $startsAt = $now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $endsAt = $now.AddHours($DurationHours).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

    $body = @{
        matchers = @(
            @{
                name    = $MatcherKey
                value   = $MatcherValue
                isRegex = $false
                isEqual = $true
            }
        )
        startsAt  = $startsAt
        endsAt    = $endsAt
        createdBy = $Author
        comment   = $Comment
    } | ConvertTo-Json -Depth 5

    $uri = "$AlertmanagerUrl/api/v2/silences"
    $response = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json" -TimeoutSec 10

    Write-Host "[SUCCESS] Silence rule activated." -ForegroundColor Green
    Write-Host "  - Silence ID : $($response.silenceID)"
    Write-Host "  - Matcher    : $MatcherKey = $MatcherValue"
    Write-Host "  - Duration   : $DurationHours hour(s) (Expires: $endsAt)"
    Write-Host "  - Author     : $Author"
    Write-Host "  - Comment    : $Comment"
}

function Remove-Silence {
    if (-not $SilenceId) {
        throw "SilenceId is required when expiring a silence. Example: -SilenceId 'e19b5b2a-...'"
    }

    $uri = "$AlertmanagerUrl/api/v2/silence/$SilenceId"
    Invoke-RestMethod -Uri $uri -Method Delete -TimeoutSec 10

    Write-Host "[SUCCESS] Silence $SilenceId expired and removed from active suppression." -ForegroundColor Green
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - ALERTMANAGER SILENCE CONTROLLER" -ForegroundColor Cyan
Write-Host "Endpoint: $AlertmanagerUrl | Action: $Action"
Write-Host "================================================================" -ForegroundColor Cyan

switch ($Action) {
    "ListAlerts"     { Get-Alerts }
    "ListSilences"   { Get-Silences }
    "CreateSilence"  { New-Silence }
    "ExpireSilence"  { Remove-Silence }
}
