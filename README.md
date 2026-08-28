# HYBRID 1.0 — Cloud-Synced Audio Generation System

## System Directory Structure

```
├── scripts/
│   ├── master_engine.py          # Local audio processing & Supabase cloud sync
│   ├── worker_daemon.py          # Persistent local job monitoring loop
│   ├── transmission_bridge.py    # Zero-crossing alignment & phase-coherence engine
│   ├── transmission_engine.py    # Vault stem reconstruction with buffer stitching
│   ├── requirements.txt          # Python dependencies
│   └── start_daemon.bat          # Windows batch launcher
│
├── src/
│   ├── app/
│   │   └── api/
│   │       ├── generate-track/
│   │       │   └── route.ts      # Token deduction RPC & job payload dispatch
│   │       └── vault/
│   │           ├── stream/
│   │           │   └── [session_id]/[file_name]/
│   │           │       └── route.ts    # Cloud storage signed-URL stream
│   │           └── transmission/
│   │               └── [session_id]/[stem_name]/
│   │                   └── route.ts    # Transmission stem stream proxy
│   │
│   └── components/
│       ├── HybridTrackCreator.tsx    # Frontend form & WebSocket listener
│       ├── HybridStemMixer.tsx       # Cloud stem mixer
│       ├── TransmissionMixer.tsx     # Multi-track mixer & WAV exporter
│       └── TrackGenerator.tsx        # Real-time status component
│
├── supabase/
│   └── migrations/
│       ├── 20260828_hybrid_vault_schema.sql  # Core schema & RPC
│       └── 20260828_transmission_logs.sql    # Transmission tracking
│
└── docs/
    ├── ARCHITECTURE.md        # System architecture overview
    ├── DEPLOYMENT.md          # Production deployment guide
    ├── ENGINE_THEORY.md       # DSP & music theory documentation
    └── WINDOWS_SERVICE.md     # NSSM service setup guide
```

---

## Deployment Checklist

### 1. Database Foundation (Supabase SQL Editor)

- [x] Execute core migration schema:
  - `user_balances`
  - `token_transactions`
  - `user_vaults`
  - `transmission_logs`
- [x] Enable RLS on all tables
- [x] Add `user_vaults` to Supabase Realtime publication
- [x] Provision `spend_hybrid_token` RPC function ($2.00 fee)

### 2. Secure Cloud Storage

- [ ] Create private `audio-vault` bucket
- [ ] Configure RLS policies:
  - Secure uploads from worker daemon
  - Signed-URL streaming to authorized users

### 3. Local Processing Engine (`D:\MusicDatasets\`)

| Component | Function |
|-----------|----------|
| `master_engine.py` | Pulls assets, applies seed randomization, time-stretching, zero-crossing summation, uploads to Supabase |
| `worker_daemon.py` | Monitors `job_payloads/` directory, executes jobs, handles errors |
| `HybridWorkerDaemon` | Windows service via NSSM with auto-recovery |

### 4. Next.js API & Frontend

| Endpoint/Component | Function |
|--------------------|----------|
| `POST /api/generate-track` | Token deduction, vault init, payload dispatch |
| `GET /api/vault/transmission/[session_id]/[stem_name]` | Signed-URL stream proxy |
| `HybridTrackCreator.tsx` | Form + WebSocket listener |
| `TransmissionMixer.tsx` | Multi-track mixer + WAV export |

### 5. Distribution Policy

**Strictly Manual**: Distribution (Too Lost, etc.) is handled entirely outside the web platform. The app's sole responsibility is:

- Generation
- Vault storage
- Cloud streaming
- Stem downloads

---

## Quick Start

### Python Environment

```bash
cd scripts
python -m venv venv
venv\Scripts\activate  # Windows
pip install -r requirements.txt
```

### Environment Variables

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
```

### Start Worker Daemon

```bash
python scripts/worker_daemon.py
```

Or install as Windows service (see `docs/WINDOWS_SERVICE.md`).

---

## Token Economics

- **Generation Fee**: $2.00 per track
- **Deduction**: Atomic RPC transaction with ledger logging
- **Balance**: Managed via `user_balances` table

---

## Audio Processing Pipeline

1. **Seed Randomization**: Session ID hashed to unique numeric seed
2. **Sample Selection**: Random loops from 1TB library matching genre/key/BPM
3. **Time-Stretching**: Phase-vocoder with transient preservation
4. **Zero-Crossing**: Click-free boundary stitching with micro-fades
5. **Stem Export**: drums, bass, melody, vocal → Supabase Storage
6. **Master Mix**: Summed stems with peak limiting at 0dBFS
7. **Status Update**: WebSocket push to frontend
