$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$distName = "Hybrid_AI_Neural_Audio_Engine_v1.0.0"
$dist = Join-Path $repo $distName
$zip = Join-Path $repo "$distName.zip"

$engineFiles = @(
    "__init__.py",
    "engine_stem_classifier.py",
    "soft_bus_router.py",
    "generate_reaper_project.py",
    "batch_export_reaper_envelopes.py",
    "live_audio_monitor.py",
    "live_stream_router.py",
    "export_reaper_envelope.py",
    "analyze_stem_anomalies.py",
    "track_activity_log.py"
)

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }

New-Item -ItemType Directory -Force -Path (Join-Path $dist "engine") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dist "models\release") | Out-Null

Copy-Item (Join-Path $repo "cli.py") (Join-Path $dist "cli.py")
Copy-Item (Join-Path $repo "requirements.txt") (Join-Path $dist "requirements.txt")
$pyproject = Get-Content (Join-Path $repo "pyproject.toml") -Raw
$pyproject = $pyproject -replace 'readme = "STEM_ENGINE.md"', 'readme = "README.md"'
Set-Content -Path (Join-Path $dist "pyproject.toml") -Value $pyproject -Encoding utf8
Copy-Item (Join-Path $repo "LICENSE") (Join-Path $dist "LICENSE")
Copy-Item (Join-Path $repo "STEM_ENGINE.md") (Join-Path $dist "README.md")

foreach ($name in $engineFiles) {
    Copy-Item (Join-Path $repo "engine\$name") (Join-Path $dist "engine\$name")
}

$srcWeight = Join-Path $repo "models\release\stem_classifier_v1.0.0.pt"
if (-not (Test-Path $srcWeight)) {
    $srcWeight = Join-Path $repo "models\checkpoints\stem_classifier_latest.pt"
}
Copy-Item $srcWeight (Join-Path $dist "models\release\stem_classifier_v1.0.0.pt")

Get-ChildItem $dist -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Compress-Archive -Path $dist -DestinationPath $zip -CompressionLevel Optimal
Get-Item $zip | Select-Object FullName, Length, LastWriteTime
Get-ChildItem $dist -Recurse -File | ForEach-Object { $_.FullName.Substring($dist.Length + 1) }
