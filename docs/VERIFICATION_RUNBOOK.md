# Hybrid 1.0 - Verification Runbook

## 1. Database Schema & Storage Verification

- [ ] Verify `user_vaults` table schema contains valid enum/string statuses: `pending`, `processing`, `completed`, `failed`

- [ ] Confirm Supabase Realtime publication includes `user_vaults` table changes:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE user_vaults;
```

- [ ] Verify `vault-storage` bucket exists and has correct RLS policies for anon / service_role write operations

---

## 2. Local Filesystem & Environment Configuration

- [ ] Ensure base directory layout exists on the workstation:

```powershell
Test-Path "D:\MusicDatasets\incoming"
Test-Path "D:\MusicDatasets\uploaded_slices"
Test-Path "D:\MusicDatasets\renders"
Test-Path "D:\MusicDatasets\archive"
Test-Path "D:\MusicDatasets\logs"
Test-Path "D:\MusicDatasets\scripts"
```

- [ ] Confirm environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are globally accessible to the Windows system environment (or inside NSSM registry keys)

- [ ] Verify FFmpeg / Libav binaries are accessible in the system PATH for pydub slice processing

---

## 3. Windows Service Execution & Logging

- [ ] Check service status and start if inactive:

```powershell
Get-Service HybridWatchdogDaemon, HybridAudioDaemon | Format-Table -AutoSize
```

- [ ] Verify log rotation parameters inside the registry via NSSM:

```powershell
nssm dump HybridWatchdogDaemon
nssm dump HybridAudioDaemon
```

- [ ] Live-tail service diagnostic streams:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\MusicDatasets\scripts\tail_logs.ps1" -Service all
```

---

## 4. Script Pipeline Chain Verification

### watchdog_slicing_daemon.py
- [ ] Drop a test audio file into `D:\MusicDatasets\incoming\heavy_alternative_rock\`
- [ ] Confirm generation of 1000ms `.wav` chunks in `D:\MusicDatasets\uploaded_slices\heavy_alternative_rock\`
- [ ] Confirm source file relocation to `archive\`

### ai_inference_engine.py
- [ ] Verify tone profile equalization and anti-click micro-fades execute cleanly without clipping

### cylinder_bus_summation.py
- [ ] Confirm sequential loading and master concatenation creates `master_output.wav` in the active render directory

### hybrid_hex_pipeline_hook.py
- [ ] Confirm deterministic SHA-256 generation and ledger record updates

### upload_master_to_cloud.py
- [ ] Verify file uploads to `vault-storage/{session_id}/master_output.wav`
- [ ] Confirm `storage_url` is committed to Supabase

### log_telemetry.py
- [ ] Verify hardware performance telemetry (CPU, RAM, D: disk percent, step duration) writes to `pipeline_telemetry_logs`

---

## 5. Frontend & Test Suite Validation

- [ ] Run Vitest pipeline tests to verify mathematical determinism and sequence order (BPM → Rhythm → Vocal):

```bash
npm run test
```

- [ ] Trigger end-to-end integration test from the workstation terminal:

```powershell
python "D:\MusicDatasets\scripts\test_pipeline_trigger.py"
```

- [ ] Validate that the Next.js `/vault` ledger dashboard:
  - Reflects the completed session
  - Displays the generated SHA-256 hash
  - Plays the master WAV directly via the Supabase storage URL

---

## Quick Verification Script

```powershell
# Run all checks in sequence
$checks = @(
    "D:\MusicDatasets\incoming",
    "D:\MusicDatasets\uploaded_slices",
    "D:\MusicDatasets\renders",
    "D:\MusicDatasets\archive",
    "D:\MusicDatasets\logs",
    "D:\MusicDatasets\scripts"
)

foreach ($path in $checks) {
    if (Test-Path $path) {
        Write-Host "[OK] $path" -ForegroundColor Green
    } else {
        Write-Host "[MISSING] $path" -ForegroundColor Red
    }
}

# Check services
Get-Service HybridWatchdogDaemon, HybridAudioDaemon -ErrorAction SilentlyContinue | Format-Table Name, Status -AutoSize

# Check FFmpeg
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host "[OK] FFmpeg found in PATH" -ForegroundColor Green
} else {
    Write-Host "[MISSING] FFmpeg not in PATH" -ForegroundColor Red
}
```
