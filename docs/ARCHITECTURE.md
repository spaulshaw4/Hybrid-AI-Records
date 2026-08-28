# HYBRID 1.0 — Core Platform Architecture (Distribution-Free)

## Local Audio Engine (`master_engine.py`)

- Slices, time-stretches, and structurally arranges the 1TB local library offline
- Applies **session-seeded randomization**, transient-locked time-stretching, and zero-crossing crossfading to ensure every track rebuild is completely unique
- Pushes finished multi-track stems (`drums`, `bass`, `melody`, `vocal`) and `_MASTER.wav` directly to Supabase Cloud Storage

---

## Cloud Storage & Vault (Supabase)

| Resource | Purpose |
|----------|---------|
| **`audio-vault` Bucket** | Secure cloud repository hosting all generated master files and isolated stems |
| **`user_vaults`** | Tracks active session statuses and triggers real-time WebSocket state changes (`processing` → `completed`) |
| **`user_balances`** | User token balance management |
| **`token_transactions`** | Secure **$2.00** token micro-transaction ledger via RPC |

---

## Backend API & Web Application (Next.js)

| Endpoint / Component | Function |
|---------------------|----------|
| **`POST /api/generate-track`** | Validates parameters, executes token deduction, initializes vault record, spawns local Python engine |
| **`GET /api/vault/stream/[session_id]/[file_name]`** | Authenticates user requests, generates time-limited secure signed URLs for cloud streaming and stem export |
| **`HybridTrackCreator.tsx`** | Interactive frontend for lyrics-driven generation with BPM/genre/length controls |
| **`TrackGenerator.tsx`** | Real-time WebSocket listener for job status updates |
| **`HybridStemMixer.tsx`** | Multi-track volume mixing, master playback, and WAV stem downloads |

---

## Transmission Layer — Reconstruction Logic

### 1. Session-Seeded Reassembly Pipeline

Rebuilding a track is not static copy-paste. Every generation tied to a unique `session_id` executes deterministic yet randomized reconstruction:

- **Seed Hashing**: Unique session string converted to numerical pseudo-random seed
- **Matrix Re-indexing**: Engine selects fresh permutation of loops from 1TB asset pool (matching key, BPM, genre), ensuring micro-variations every rebuild

```python
def _seed_randomizer(self, session_id):
    numeric_seed = abs(hash(session_id)) % (10 ** 8)
    random.seed(numeric_seed)
    np.random.seed(numeric_seed)
```

### 2. Transient-Locked Time-Stretch Transmission

- **Phase-Vocoder Recalculation**: `rate = Target BPM / Original BPM`
- **Transient Preservation**: Aligns downbeats and snare hits to master timeline grid, preventing rhythmic drift across verses and choruses

### 3. Crossfade & Zero-Crossing Reconstruction Buffer

- **Buffer Stitching**: 512-sample boundary radius on either side of cut points
- **Phase Alignment & Fading**: Forces zero-crossing amplitude convergence with micro-fade envelope, eliminating clicks and phase cancellation

---

## Distribution Policy

**Strictly Manual**: All releases (to Too Lost or other distributors) are handled entirely outside the web platform.

The web app's sole responsibility:
- Generation
- Vault storage
- Cloud streaming
- Stem downloads

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│  HybridTrackCreator (UI)                                    │
│  └── Captures Lyrics, BPM, Genre, Vocal Prompt              │
│  └── POST /api/generate-track ($2.00 Token)                 │
├─────────────────────────────────────────────────────────────┤
│  Next.js API Route                                          │
│  └── Validates Balance via Supabase RPC                     │
│  └── Writes job payload to D:\MusicDatasets\                │
│  └── Spawns Local Python Engine                             │
├─────────────────────────────────────────────────────────────┤
│  Python Engine (100% Offline DSP)                           │
│  └── Session-seeded loop selection                          │
│  └── Time-stretch, Key match, Arrange                       │
│  └── Uploads Stems to Supabase Storage                      │
│  └── Updates user_vaults status = 'completed'               │
├─────────────────────────────────────────────────────────────┤
│  TrackGenerator (WebSocket Listener)                        │
│  └── Receives instant status update                         │
│  └── Unlocks UI when rendering finishes                     │
├─────────────────────────────────────────────────────────────┤
│  HybridStemMixer (Audio Vault)                              │
│  └── Streams via /api/vault/stream/[session]/[file]         │
│  └── Live mixing & direct WAV export                        │
│  └── Manual distribution handled externally                 │
└─────────────────────────────────────────────────────────────┘
```
