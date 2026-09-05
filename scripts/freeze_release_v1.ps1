$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
$epoch10 = Join-Path $repo "models\checkpoints\stem_classifier_epoch_10.pt"
$latest = Join-Path $repo "models\checkpoints\stem_classifier_latest.pt"
$destDir = Join-Path $repo "models\release"
$dest = Join-Path $destDir "stem_classifier_v1.0.0.pt"
Write-Output "[FREEZE] Waiting for $epoch10"
while (-not (Test-Path $epoch10)) {
    Start-Sleep -Seconds 30
}
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
Copy-Item $latest $dest -Force
Write-Output "[FREEZE] Locked production weights -> $dest"
