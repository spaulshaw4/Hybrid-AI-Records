# HYBRID 1.0 — Core Platform Architecture

Two cooperating systems: a TanStack Start web app, and a local Python render
engine behind a FastAPI worker on `127.0.0.1:8880`. The web app owns identity,
tokens, queueing, and the vault. The engine owns everything audio.

---

## 1. Web Application (TanStack Start)

Not Next.js. Routes are file-based under `src/routes/`, and a single route file
is either a **page** (exports `component`) or an **endpoint** (declares
`server.handlers`). SSR runs through Nitro via `src/server.ts`, which also
dispatches two standalone handlers (`/api/coproducer`,
`/api/ai/optimize-prompt`) that predate the route convention.

| Surface | Role |
|---------|------|
| `/engine` → `AudioStudio.tsx` | Four-step studio: title & lyrics → sound & style → vocals → fine-tune & generate |
| `/api/studio/generate-queue` | Enqueue through the cortex dispatcher |
| `/generate` | POST proxy straight to the local worker |
| `/api/tracks/status/$sessionId` | Job polling (4 s cadence; no WebSocket) |
| `/api/tracks/feedback` *(worker)* | Implicit playback verdicts |
| `/api/stream/$filename` | Range-capable audio streaming |

### The Cortex Dispatcher

`src/lib/cortex-dispatcher.server.ts` is the control plane for every studio
generation. Three sequential gates run before any audio work:

1. **Identity & token authorization** — request-scoped `resolveStudioSession`,
   never a shared admin identity; the token is burned atomically up front
2. **Queue & throttle** — one shared upstream key, drained sequentially
3. **Vault writer** — a `user_vault` row is opened at enqueue and bound to the
   queued job's `user_id`, then completed by the worker

A failure in gate 2 or 3 refunds the burned token.

---

## 2. Six-Gate Render Pipeline

Completion is tracked as a bitmask (`src/lib/pipeline-flags.ts`). The studio
lights badges **only** from the server-dispatched mask and never predicts
ahead. All six bits are required before settlement debits tokens.

| Bit | Gate | Stage |
|-----|------|-------|
| 1 | `COMPOSITION` | Base audio render |
| 2 | `STORAGE` | Vault ingest → public HTTPS URL |
| 4 | `STRUCTURE` | CWALO music-structure analysis |
| 8 | `DEMUX` | Demucs stem separation |
| 16 | `VOCALS` | RVC / Fish Audio voice conversion |
| 32 | `MASTERING` | FFmpeg master + final commit |

Gate 1 prefers the **local Hybrid worker**: `hybrid-worker.server.ts` posts to
`:8880` whenever a worker URL resolves, falling back to a cloud provider only
if it does not. That makes the local corpus engine the default composer, not a
fallback.

---

## 3. Render Engine

`engine/generate_track_headless.py` is the entry point. The worker runs it as a
subprocess, then `scripts/run_master_pipeline.ps1`.

### 3.1 Conducting — what the song *is*

`local_song_conductor.conduct_arrangement` produces a `GlobalSongPlan`:
section map (intro / verse / chorus / bridge / outro with bar spans), an energy
arc, a chord roadmap resolved per bar (`Am7`, `Fmaj7`, …), key and tempo, plus
`mix_intents`. Key selection is genre-aware rather than hard-coded.

### 3.2 Selection — stems chosen by measured fit

`stem_selector.select_for_role` scores candidates from the corpus index. With
harmonic context supplied, the weighting is:

| Component | Weight | Meaning |
|-----------|--------|---------|
| `chord` | 0.22 | Share of the slice's **measured** pitch energy on the progression's tones |
| `bpm` | 0.22 | Tempo distance inside the 0.5–2.0 WSOLA stretch clamp |
| `key` | 0.16 | Circle-of-fifths compatibility of the `detected_key` label |
| `centroid` | 0.16 | Spectral fit for the role |
| `level` | 0.14 | Loudness window for the role |
| `groove` | 0.10 | Accent-pattern similarity over a 16-step bar grid |

`chord` and `groove` read `slice_musical` — a 12-bin chroma and 16-step onset
grid measured for every one of the 1,385,549 slices. Before this existed the
picker only knew one root label per slice, so an `Fmaj7` bar could be filled
from an `Am7` slice unchecked.

Because stems are staged **once per role for a whole track**, a single pick
cannot satisfy every bar. Scoring therefore uses the progression's
duration-weighted pitch classes (`plan_pitch_weights`) rather than one bar's
chord. The per-bar path (`chord_fit`) is implemented and tested, ready for
per-section staging.

An unmeasured slice scores a neutral `0.5`, and callers that pass no harmonic
context keep the original four-weight behaviour exactly.

> Measured on the A-minor cyberpunk progression at full coverage: harmonic fit
> **0.533 → 0.703 (+31.8%)**; the harmonic bus alone reached **0.802**.
> Reproduce with `python scripts/ab_harmonic_fit.py`.

### 3.3 Arrangement & Mixing

`blueprint_track_assembler.assemble_from_blueprint` builds four buses —
rhythm, bass, harmonic, vocal — holding one loop per bus per phrase (the 8-bar
lock), varying across sections, gated by a ramped activation envelope so a bus
can drop out entirely.

Mix authority is split deliberately:

- the **picker** may only choose stems
- the **song plan** names *when* sections happen
- `genre_planner` owns *how* they sound — mutes, stereo width, sidechain pump,
  lowpass — via `GENRE_BLUEPRINTS` derived from the Prompt Book

`relational_mixer` then replaces blind summing with relational rules: kick→bass
transient snap, kick→bass low-end ducking, 1–3.5 kHz vocal pocketing, and one
shared-room reverb with per-bus wet returns. Section windows are blended
equal-gain, and the genre reaches the mixer through `genre_from_plan` so a
cyberpunk render is never mixed like electroswing.

### 3.4 Mastering

`mastering_bus` targets **−14 LUFS ±0.5** (BS.1770-4, K-weighted and gated)
with a −1.0 dBTP ceiling via 4× oversampled true-peak detection. A mix that
cannot reach the window inside the 8.5 dB push limit **fails the render** rather
than shipping out of spec.

---

## 4. Learning Loop

The scorer's weights were set by judgement. The ledger exists to replace them
with evidence.

`mix_history` records, during the render:

- **`mix_sessions`** — key, tempo, progression, pitch weights, scorer in force
- **`mix_decisions`** — every scored candidate per role with its component fits,
  flagged chosen or not. One render logs ~429 rows against ~12 staged stems

It is written mid-render by necessity: delivery purges the scratch tree, so the
stems are gone by the time a verdict arrives. Verdicts attach later by
`session_id`.

Feedback is **implicit** — no rating UI. `src/lib/engine-feedback.ts` emits one
verdict per listen, reporting the furthest point reached:

| Signal | Label |
|--------|-------|
| Download | `+1.0` |
| Full playthrough | `+1.0` |
| Skip past the first third | scaled by fraction heard |
| Skip inside the first third | negative, to `−1.0` on an instant skip |

The negative is the point: a loop trained only on exports learns that
everything is good. `training_pairs()` returns the chosen stems from
well-received renders with their component fits — the positive side of a
learning-to-rank problem, with the losers retained for the pairwise fit.

Each approved track yields hundreds of labelled comparisons rather than one,
which is what makes fitting viable at this catalogue's track count.

---

## 5. Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  /engine — AudioStudio (TanStack page)                       │
│  └── title, lyrics, style chips, vocals, duration            │
│  └── POST /api/studio/generate-queue  ($2.00 token)          │
├──────────────────────────────────────────────────────────────┤
│  Cortex Dispatcher (server)                                  │
│  └── Gate 1 identity + atomic token burn                     │
│  └── Gate 2 sequential queue                                 │
│  └── Gate 3 opens the user_vault row                         │
├──────────────────────────────────────────────────────────────┤
│  Gate 1 compose → local worker :8880                         │
│  └── generate_track_headless.py (subprocess)                 │
│      ├── conduct_arrangement  → sections, energy, chords     │
│      ├── select_for_role      → chroma + groove scored picks │
│      │                          (logs ~429 decisions)        │
│      ├── assemble_from_blueprint → 4 buses, section stitch   │
│      ├── genre_planner        → per-section mutes/width/pump │
│      └── relational_mixer     → snap, duck, pocket, reverb   │
│  └── run_master_pipeline.ps1  → −14 LUFS, −1.0 dBTP          │
├──────────────────────────────────────────────────────────────┤
│  Gates 2-6 → vault ingest, CWALO, Demucs, RVC, master commit │
│  └── pipelineState bitmask returned to the studio            │
├──────────────────────────────────────────────────────────────┤
│  Studio polls /api/tracks/status/{id} every 4 s              │
│  └── badges light from the server mask only                  │
├──────────────────────────────────────────────────────────────┤
│  Playback / download → POST /api/tracks/feedback             │
│  └── implicit verdict joins mix_decisions by session_id       │
└──────────────────────────────────────────────────────────────┘
```

---

## 6. Storage

| Resource | Purpose |
|----------|---------|
| `user_vault` (Supabase) | Track rows, status `processing` → `completed`, stem URLs |
| `audio-vault` bucket | Masters and isolated stems, served by signed URL |
| `token_transactions` | $2.00 micro-transaction ledger |
| `C:\live_web_outputs\renders\` | Local master output per session |
| `C:\live_web_outputs\deliveries\` | Packaged master, MP3, stems bundle, manifest |
| `C:\live_web_outputs\scratch\` | Per-session working tree, **purged after delivery** |
| `C:\staging_slices\` | NVMe slice corpus read by the worker |

---

## 7. Distribution Policy

**Strictly manual.** All releases are handled outside the platform. The app's
responsibility is generation, vault storage, streaming, and stem download.
