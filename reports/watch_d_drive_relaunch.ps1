$ErrorActionPreference = "Continue"
$repo = "C:\Users\spaul\Downloads\Hybrid AI Forge (10)"
$py = "C:\Users\spaul\AppData\Local\Programs\Python\Python312\python.exe"
$locked = "D:\MusicDatasets\mtg\corpus_4s_dsp_locked"
$corpus = "D:\MusicDatasets\corpus_4s"
$staging = "C:\staging_slices"
$flag = Join-Path $repo "reports\d_drive_relaunched.flag"
$lockScript = Join-Path $repo "scripts\lock_native_dsp_slices.py"
$lockOut = Join-Path $repo "reports\lock_relaunch.out.log"
$lockErr = Join-Path $repo "reports\lock_relaunch.err.log"
$roboLog = Join-Path $repo "reports\robocopy_relaunch.log"
Write-Output "[WATCH] Waiting for D: corpus/locked roots..."
while ($true) {
  $ok = (Test-Path $corpus) -and (Test-Path (Split-Path $locked -Parent))
  if ($ok) {
    if (-not (Test-Path $locked)) { New-Item -ItemType Directory -Path $locked -Force | Out-Null }
    Write-Output "[WATCH] D: online at $(Get-Date -Format o)"
    if (-not (Test-Path $flag)) {
      Write-Output "[WATCH] Starting lock_native_dsp_slices.py"
      Start-Process -FilePath $py -ArgumentList '-u',"`"$lockScript`"",'--workers','8','--chunksize','64','--progress-every','2000' -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $lockOut -RedirectStandardError $lockErr
      Write-Output "[WATCH] Starting robocopy to staging"
      Start-Process -FilePath "robocopy.exe" -ArgumentList "`"$locked`"","`"$staging`"","/E","/XO","/MT:8","/R:2","/W:5","/XF","*.db","*.sqlite","*.jsonl","/LOG+:`"$roboLog`"" -WindowStyle Hidden
      "relaunched $(Get-Date -Format o)" | Set-Content -Path $flag -Encoding ascii
    } else {
      Write-Output "[WATCH] Flag exists — lock/robocopy already launched this session"
    }
    break
  }
  Start-Sleep -Seconds 60
}
Write-Output "[WATCH] Done"
