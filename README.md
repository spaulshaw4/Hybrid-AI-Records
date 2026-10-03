# HYBRID 1.0 — Corpus-Driven Audio Generation System

A TanStack Start web app over a local Python render engine. Tracks are
assembled from a 1.38M-slice corpus by measured musical fit, mixed by a
genre rulebook, and mastered to broadcast loudness.

## Stack

| Layer | Technology |
|-------|-----------|
| Web app | TanStack Start (React 19, Vite, Nitro SSR) |
| Routing | File-based routes under `src/routes/` |
| Render engine | Python 3.12 (`engine/`), numpy + scipy DSP |
| Local worker API | FastAPI on `127.0.0.1:8880` (`api/headless_job_runner.py`) |
| Catalogs | SQLite (corpus index, acoustic profiles, mix ledger) |
| Cloud | Supabase (auth, `user_vault`, storage), Stripe (tokens) |

> Routes live in `src/routes/`, **not** `src/app/`. This is not a Next.js app;
> there are no `next/server` route handlers. The two files remaining under
> `src/app/api/` (`coproducer`, `ai/optimize-prompt`) are plain handlers
> dispatched explicitly from `src/server.ts`.

---

## Directory Structure

```
├── engine/                          # Python render engine
│   ├── generate_track_headless.py   # Entry: prompt → blueprint → unmastered mix
│   ├── local_song_conductor.py      # Section map, energy arc, harmonic roadmap
│   ├── genre_planner.py             # Prompt Book rulebook: mutes / width / pump / LPF
│   ├── stem_selector.py             # Weighted musical fit scoring + seeded pick
│   ├── musical_features.py          # Chroma (12-bin) + 16-step onset grid
│   ├── musical_index.py             # Read-only accessor for measured features
│   ├── blueprint_track_assembler.py # 4-bus arrangement + section stitching
│   ├── relational_mixer.py          # Kick→bass snap, sidechain, vocal pocket, reverb
│   ├── conductor_matrix.py          # Per-bar DSP (mutes, mid/side width, filters)
│   ├── mastering_bus.py             # BS.1770-4 loudness + true-peak limiting
│   └── mix_history.py               # Decision + implicit-verdict ledger
│
├── api/
│   └── headless_job_runner.py       # FastAPI worker on :8880
│
├── scripts/
│   ├── extract_musical_features.py  # Corpus chroma / onset backfill (resumable)
│   ├── extract_acoustic_profiles.py # Centroid / transient / RMS profiles
│   ├── ab_harmonic_fit.py           # A/B benchmark: legacy vs chord-aware picking
│   ├── ingest_corpus.py             # Unpack → slice → features → relabel
│   └── run_master_pipeline.ps1      # Mastering + delivery packaging
│
├── src/
│   ├── routes/                      # TanStack file-based routes (pages + endpoints)
│   ├── components/
│   │   ├── AudioStudio.tsx          # The 4-step studio (/engine)
│   │   ├── AudioVault.tsx           # Vault browser + player
│   │   └── TransmissionMixer.tsx    # Multi-track mixer + WAV export
│   └── lib/
│       ├── hybrid-worker.server.ts  # Gate 1 → local worker on :8880
│       ├── cortex-dispatcher.server.ts  # Identity / queue / vault control plane
│       ├── engine-feedback.ts       # Implicit playback verdicts → ledger
│       └── pipeline-flags.ts        # Six-gate completion bitmask
│
└── docs/
    ├── ARCHITECTURE.md              # Pipeline + data flow
    ├── DEPLOYMENT.md                # Production deployment
    ├── ENGINE_THEORY.md             # DSP & music theory
    └── WINDOWS_SERVICE.md           # NSSM service setup
```

---

## Routing

File-based. A route is a **page** when it exports a `component`, and an
**endpoint** when it declares `server.handlers` without one.

| Route | Kind | Purpose |
|-------|------|---------|
| `/engine` | page | The studio — `AudioStudio`, 4-step generate flow |
| `/portal`, `/artists`, `/tokens` | page | Catalog, roster, token purchase |
| `/track/$trackId` | page | Single-track player |
| `/generate` | endpoint | POST proxy → local worker `:8880` |
| `/api/studio/generate-queue` | endpoint | Enqueue via the cortex dispatcher |
| `/api/studio/generate-stream` | endpoint | SSE generate (legacy inline path) |
| `/api/studio/vault/tracks` | endpoint | Vault listing / delete |
| `/api/tracks/create`, `/api/tracks/status/$sessionId` | endpoint | Worker job proxy |
| `/api/stream/$filename` | endpoint | Range-capable audio streaming |
| `/api/pipeline/master` | endpoint | Mastering trigger |

`_authenticated/` routes require a session. `dev.*` and `_authenticated/*` are
`noindex` and excluded from `sitemap.xml`; the sync is enforced by
`src/test/sitemap-robots-sync.test.ts`.

---

## Local Worker API (`127.0.0.1:8880`)

```
GET  /health                      → brain + corpus + index status
POST /generate                    → {session_id, status} (JSON or multipart w/ vocal_file)
GET  /api/tracks/status/{id}      → job status, LUFS, stem URLs, song_plan
POST /api/tracks/feedback         → implicit verdict (export | play)
GET  /api/stream/{filename}       → master / stems / bundle
```

Launch without `--reload` (a reload loop restarts mid-render):

```powershell
$env:HYBRID_STEP_TIMEOUT_SEC = '900'   # 96-bar renders exceed 5 min
$env:HYBRID_MAX_RENDERS = '1'          # each render peaks ~1.5 GB
uvicorn main:app --host 0.0.0.0 --port 8880
```

---

## Catalogs

| Database | Contents |
|----------|----------|
| `corpus_index_live.sqlite` | 1,385,549 slices: stem type, key, BPM, RMS, centroid. Read-only replica of the D: catalog, refreshed every 6 h |
| `hybrid_acoustic_profiles.db` | `slice_musical` — 12-bin chroma + 16-step onset grid per slice (100% coverage). `stem_features` — centroid / transient density / RMS |
| `hybrid_mix_history.db` | `mix_decisions` (every scored candidate + which was staged), `mix_verdicts` (implicit export / playthrough / skip labels) |

The live corpus index is **never written** by the engine. Feature extraction
writes only to its own file and refuses to open the catalog; see
`engine/acoustic_profiles.py`.

---

## Quick Start

```bash
npm install
npm run dev                     # Vite on :8080, proxies /generate + /api/tracks → :8880
```

```bash
pip install -r requirements-engine.txt
uvicorn main:app --host 0.0.0.0 --port 8880
```

### Environment

```env
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
HYBRID_WORKER_URL=http://127.0.0.1:8880   # omit to use the default
HYBRID_WORKER_TOKEN=...                    # required only for tunneled access
```

---

## Tests

```bash
npm run test          # vitest
npx tsc --noEmit      # type gate (CI blocks on this)
python -m pytest tests -q
```

CI (`.github/workflows/`) gates on vitest, the axe-core accessibility suite,
the payments matrix, `tsc --noEmit`, the production build, and a scoped set of
Python DSP kernel tests.

---

## Token Economics

- **$2.00 per generation**, debited through an atomic Supabase RPC with a
  ledger row
- Charged per completed gate (`GATE_LINE_ITEMS` in `src/lib/pipeline-flags.ts`)
- Settlement requires all six gate bits; a failed render refunds

---

## Distribution Policy

**Strictly manual.** Distribution (Too Lost and others) happens entirely
outside the platform. The app's responsibility ends at generation, vault
storage, streaming, and stem download.
