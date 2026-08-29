<#
.SYNOPSIS
    Binary-safe dataset downloader with error-page and truncation detection.
.DESCRIPTION
    Every corrupt archive found on this workstation failed for one of four
    reasons, none of which a plain download reports as an error:

      1. UTF-16 text mangling - piping curl output through a PowerShell text
         stream (`curl ... | Out-File`) re-encodes raw bytes as UTF-16LE, so
         every byte gains a null. pod_stems\test_tar.tar shows this signature.
      2. HTML error pages saved under an archive name - bass_db.tar.gz and
         medley_solos.tar.gz are both gzipped HTML login/404 pages, 14 KB each.
      3. JSON API errors saved as archives - pod_stems\scratch.tar is the
         22-byte body {"detail":"Not Found"}.
      4. Silent truncation - scratch_full.tar is 1.5 GB of a larger file whose
         transfer died mid-stream.

    This script defends against all four:
      - writes via curl.exe -o (never a PowerShell pipeline), so bytes stay raw
      - inspects the response Content-Type and rejects text/html and
         application/json before saving
      - compares the final size against Content-Length
      - sniffs magic bytes to confirm the file really is the archive type
      - runs `tar -tf` as a structural check
      - resumes partial transfers with -C - rather than restarting

.PARAMETER Url
    Source URL.
.PARAMETER OutFile
    Destination path. Parent directories are created.
.PARAMETER ExpectedSha256
    Optional checksum to verify after download.
.PARAMETER SkipIntegrityTest
    Skip the tar -tf structural check (use for non-archive payloads).
.EXAMPLE
    .\fetch_dataset_binary.ps1 -Url "https://zenodo.org/records/.../files/FSD50K.dev_audio.z01" -OutFile "D:\MusicDatasets\fsd50k\FSD50K.dev_audio.z01"
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$Url,

    [Parameter(Mandatory=$true)]
    [string]$OutFile,

    [string]$ExpectedSha256 = "",

    [switch]$SkipIntegrityTest = $false,

    [int]$MaxRetries = 100,

    [int]$RetryDelaySec = 3
)

$ErrorActionPreference = "Stop"

# curl.exe explicitly: bare `curl` in PowerShell is an alias for
# Invoke-WebRequest, whose output through a pipeline is text-encoded.
$curl = Join-Path $env:SystemRoot "System32\curl.exe"
if (-not (Test-Path $curl)) {
    $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "curl.exe not found. Windows 10 1803+ ships it in System32." }
    $curl = $cmd.Source
}

$parent = Split-Path $OutFile -Parent
if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "HYBRID 1.0 - BINARY-SAFE DATASET FETCH" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "URL    : $Url"
Write-Host "Output : $OutFile"
Write-Host "================================================================" -ForegroundColor Cyan

# -------------------------------------------------------------------------
# 1. HEAD request: reject error pages before writing a single byte
# -------------------------------------------------------------------------
Write-Host "`n[1/5] Inspecting response headers..." -ForegroundColor Yellow

$headers = & $curl -sIL --max-time 60 $Url 2>&1
$contentType = ($headers | Select-String -Pattern "^content-type:" | Select-Object -Last 1) -replace "(?i)^content-type:\s*", ""
$contentLengthRaw = ($headers | Select-String -Pattern "^content-length:" | Select-Object -Last 1) -replace "(?i)^content-length:\s*", ""
$statusLine = ($headers | Select-String -Pattern "^HTTP/" | Select-Object -Last 1)

Write-Host "  Status       : $($statusLine -replace '\s+$','')"
Write-Host "  Content-Type : $(if ($contentType) { $contentType.Trim() } else { '<none>' })"

$expectedBytes = 0
if ($contentLengthRaw -and [long]::TryParse($contentLengthRaw.Trim(), [ref]$expectedBytes)) {
    Write-Host "  Content-Length: $([math]::Round($expectedBytes/1GB,2)) GB ($expectedBytes bytes)"
}

if ($contentType -match "text/html|application/json|text/plain") {
    Write-Host "`n[ABORT] Server is returning '$($contentType.Trim())', not a binary payload." -ForegroundColor Red
    Write-Host "        This is the exact failure that produced bass_db.tar.gz and" -ForegroundColor Yellow
    Write-Host "        medley_solos.tar.gz - an HTML page saved under an archive name." -ForegroundColor Yellow
    Write-Host "        The URL likely needs authentication or has moved." -ForegroundColor Yellow
    exit 1
}

# -------------------------------------------------------------------------
# 2. Download straight to disk, resumable, never through a text pipeline
# -------------------------------------------------------------------------
Write-Host "`n[2/5] Downloading (resumable, raw bytes to disk)..." -ForegroundColor Yellow

$sw = [System.Diagnostics.Stopwatch]::StartNew()

& $curl -L -C - --retry $MaxRetries --retry-delay $RetryDelaySec --retry-all-errors `
    --fail-with-body -o $OutFile $Url

$curlExit = $LASTEXITCODE
$sw.Stop()

if ($curlExit -ne 0) {
    Write-Host "[ERROR] curl exited $curlExit after $([math]::Round($sw.Elapsed.TotalMinutes,1)) min." -ForegroundColor Red
    Write-Host "        Partial file retained at $OutFile - re-run to resume." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $OutFile)) {
    Write-Host "[ERROR] curl reported success but no file exists." -ForegroundColor Red
    exit 1
}

$actualBytes = (Get-Item $OutFile).Length
Write-Host "  Wrote $([math]::Round($actualBytes/1GB,2)) GB in $([math]::Round($sw.Elapsed.TotalMinutes,1)) min"

# -------------------------------------------------------------------------
# 3. Size check against Content-Length catches silent truncation
# -------------------------------------------------------------------------
Write-Host "`n[3/5] Verifying transfer completeness..." -ForegroundColor Yellow

if ($expectedBytes -gt 0) {
    if ($actualBytes -ne $expectedBytes) {
        Write-Host "[ERROR] Size mismatch: got $actualBytes, expected $expectedBytes." -ForegroundColor Red
        Write-Host "        This is the scratch_full.tar failure mode. Re-run to resume." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  Size matches Content-Length exactly." -ForegroundColor Green
} else {
    Write-Host "  Server sent no Content-Length; size cannot be verified." -ForegroundColor Yellow
}

# -------------------------------------------------------------------------
# 4. Magic-byte sniff catches text-mangled and mislabelled payloads
# -------------------------------------------------------------------------
Write-Host "`n[4/5] Checking magic bytes..." -ForegroundColor Yellow

$fs = [System.IO.File]::OpenRead($OutFile)
try {
    $magic = New-Object byte[] 8
    $read = $fs.Read($magic, 0, 8)
} finally {
    $fs.Close()
}

$hex = ($magic[0..([Math]::Min(3, $read-1))] | ForEach-Object { $_.ToString("X2") }) -join " "
Write-Host "  First bytes: $hex"

$looksGzip = ($magic[0] -eq 0x1F -and $magic[1] -eq 0x8B)
$looksZip  = ($magic[0] -eq 0x50 -and $magic[1] -eq 0x4B)
$looksUtf16 = ($read -ge 4 -and $magic[1] -eq 0x00 -and $magic[3] -eq 0x00)

if ($looksUtf16) {
    Write-Host "[ERROR] Every second byte is null - the payload was written as UTF-16 text." -ForegroundColor Red
    Write-Host "        This is the test_tar.tar corruption. Never pipe binary through" -ForegroundColor Yellow
    Write-Host "        PowerShell; curl -o writes raw bytes." -ForegroundColor Yellow
    exit 1
}

$ext = [System.IO.Path]::GetExtension($OutFile).ToLower()
if ($ext -in @(".gz", ".tgz") -and -not $looksGzip) {
    Write-Host "[WARN] Extension implies gzip but magic bytes are not 1F 8B." -ForegroundColor Yellow
}
if ($ext -eq ".zip" -and -not $looksZip) {
    Write-Host "[WARN] Extension implies zip but magic bytes are not PK." -ForegroundColor Yellow
}

# Gzipped HTML: gzip magic is valid, but the decompressed head is markup
if ($looksGzip) {
    $probe = & (Join-Path $env:SystemRoot "System32\tar.exe") -tf $OutFile 2>&1
    if ($LASTEXITCODE -ne 0 -and ($probe -join " ") -match "Unrecognized archive format") {
        Write-Host "[ERROR] Valid gzip stream, but not a tar archive - almost certainly a" -ForegroundColor Red
        Write-Host "        gzip-compressed HTML page, as with bass_db.tar.gz." -ForegroundColor Yellow
        exit 1
    }
}

# -------------------------------------------------------------------------
# 5. Optional checksum, then structural integrity
# -------------------------------------------------------------------------
if ($ExpectedSha256) {
    Write-Host "`n[5/5] Verifying SHA-256..." -ForegroundColor Yellow
    $actualHash = (Get-FileHash -Path $OutFile -Algorithm SHA256).Hash
    if ($actualHash -ne $ExpectedSha256.ToUpper()) {
        Write-Host "[ERROR] Checksum mismatch." -ForegroundColor Red
        Write-Host "        expected $($ExpectedSha256.ToUpper())" -ForegroundColor Yellow
        Write-Host "        actual   $actualHash" -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  Checksum verified." -ForegroundColor Green
} elseif (-not $SkipIntegrityTest) {
    Write-Host "`n[5/5] Structural integrity test..." -ForegroundColor Yellow
    $tarExe = Join-Path $env:SystemRoot "System32\tar.exe"
    $listing = & $tarExe -tf $OutFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Archive failed tar -tf: $($listing | Select-Object -First 1)" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Readable: $(($listing | Measure-Object).Count) entries." -ForegroundColor Green
} else {
    Write-Host "`n[5/5] Integrity test skipped." -ForegroundColor Gray
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "[SUCCESS] $OutFile is complete and readable." -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
