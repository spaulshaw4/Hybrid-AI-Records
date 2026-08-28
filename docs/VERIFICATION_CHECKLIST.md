# Hybrid 1.0 - System Verification Checklist

## 1. Supabase Database & Storage Verification

### Table Schema
Ensure the `user_vaults` table exists with columns:
- `session_id` (text, unique)
- `user_id` (text)
- `genre_lock` (text)
- `status` (text)
- `master_hash` (text)
- `storage_url` (text)
- `metadata` (jsonb)
- `created_at` (timestamp with time zone)

### Extensions & Security
- [ ] Verify that the `vector` extension is enabled
- [ ] Row Level Security (RLS) policies permit full access for `service_role`

### Storage Bucket
- [ ] Confirm `vault-storage` bucket is created
- [ ] Public read access enabled
- [ ] Service-role write permissions configured

### Environment Keys
Ensure these are present in both Next.js `.env.local` and local Python environment:
- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`

---

## 2. Next.js Frontend & API Verification

### Frontend Component
- [ ] `GenerationTrigger` component renders correctly
- [ ] Dispatches POST request to `/api/generate` with `userId` and `genreLock`

### API Endpoint (`/api/generate/route.ts`)
- [ ] Validates payload inputs
- [ ] Enforces token transaction structure
- [ ] Generates unique session ID prefixed with `hyb_`
- [ ] Inserts new record into `user_vaults` with `status: 'pending'`

---

## 3. Local D: Drive Directory Architecture

Verify the following directory structure is fully initialized:

```
D:\MusicDatasets\
├── incoming\
│   ├── heavy_alternative_rock\
│   ├── nu_metal\
│   └── amapiano\
├── uploaded_slices\
│   ├── heavy_alternative_rock\
│   └── ...
├── archive\
├── renders\
└── scripts\
    ├── daemon_poller.py
    ├── watchdog_slicer.py
    ├── ai_inference_engine.py
    ├── cylinder_bus_summation.py
    ├── hybrid_hex_pipeline_hook.py
    ├── upload_master_to_cloud.py
    └── run_master_pipeline.ps1
```

---

## 4. Background Services & NSSM Configuration

### Watchdog Service (`HybridWatchdogDaemon`)
- [ ] Running persistently via NSSM
- [ ] Monitoring `D:\MusicDatasets\incoming` for incoming audio assets
- [ ] Converting to 1000ms `.wav` slices
- [ ] Archiving source files

### Pipeline Daemon (`HybridAudioDaemon`)
- [ ] Running persistently via NSSM
- [ ] Polling Supabase every 10 seconds for pending sessions
- [ ] Handing execution to master PowerShell script

### Execution Permissions
- [ ] PowerShell execution policy bypassed (`-ExecutionPolicy Bypass`)

### Service Management Commands
```powershell
# Check service status
nssm status HybridAudioDaemon
nssm status HybridWatchdogDaemon

# Restart services
nssm restart HybridAudioDaemon
nssm restart HybridWatchdogDaemon

# View logs
nssm edit HybridAudioDaemon
```

---

## 5. End-to-End Execution Flow Test

### Ingestion Test
1. Drop a sample audio file into `D:\MusicDatasets\incoming\heavy_alternative_rock\`
2. Verify the watchdog slices it into `uploaded_slices`
3. Verify the original is archived

### Trigger Test
1. Submit a generation request through the Next.js UI
2. Verify a new row appears in `user_vaults` with `status: 'pending'`

### Processing Test
1. Watch the daemon pick up the job (`status` → `processing`)
2. Execute the PowerShell pipeline
3. Generate 420 stems
4. Stitch them sequentially
5. Compute SHA-256 hash
6. Lock the vault (`status` → `completed`)

### Cloud & Cleanup Test
1. Verify `master_output.wav` uploads to `vault-storage` bucket
2. Verify public URL is saved back to Supabase `storage_url` column
3. Verify local temporary raw stems purged from `D:\MusicDatasets\renders\{session_id}\raw_stems`

---

## Quick Verification Commands

```powershell
# Check Python environment
python --version
pip list | Select-String "supabase|pydub|watchdog|psutil"

# Test Supabase connection
python -c "import os; from supabase import create_client; c = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY']); print(c.table('user_vaults').select('*').limit(1).execute())"

# Run health check
python D:\MusicDatasets\scripts\health_check.py

# Launch telemetry monitor
python D:\MusicDatasets\scripts\telemetry_monitor.py

# Dispatch test session
python D:\MusicDatasets\scripts\dispatch_test_session.py
```
