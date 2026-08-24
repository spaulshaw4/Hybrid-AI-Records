# Railway deployment

## Config in this repo

| File | Purpose |
| --- | --- |
| `railway.json` | Nixpacks builder, start command, healthcheck, restart policy |
| `nixpacks.toml` | Bun install/build; start via `bun run start`; FFmpeg + Matchering |
| `package.json` | `"start": "bun .output/server/index.mjs"` |
| `.dockerignore` | Excludes noise/secrets but **not** `.output` |

The build emits a Nitro `node-server` bundle at `.output/`. Production start is
`bun run start` → `bun .output/server/index.mjs`.

## System dependencies

Two binaries are spawned at runtime, not imported:

- **FFmpeg** — stem mixing, loudness normalization, and the master duration
  ceiling with fade-out. Without it Gate 5 throws "FFmpeg is not installed on
  this host" and no master is produced.
- **Python + Matchering 2.0** — reference-matched mastering. Without it the
  pipeline logs `Python runtime not found` and falls back to loudnorm only, so
  tracks still render but lose the catalog's tonal signature.

Set `MATCHERING_PYTHON` if the interpreter is not on `PATH` as `python3`.

## Environment variables

### Required — the render fails without these

| Variable | Used for |
| --- | --- |
| `AIMUSICAPI_KEY` | Gate 1 base generation. `MUSICAPI_KEY`, `MUSIC_API_KEY` and `SONIC_API_KEY` are accepted aliases |
| `REPLICATE_API_KEY` | Gate 3 Demucs stem separation. `REPLICATE_API_TOKEN` also accepted |
| `FISH_AUDIO_API_KEY` | Gate 4 vocal synthesis. `FISH_API_KEY` also accepted |
| `SUPABASE_URL` | Database and storage endpoint |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side storage uploads and vault writes. Without it every artifact falls back to the on-disk local vault, which does not survive a redeploy |
| `SUPABASE_PUBLISHABLE_KEY` | Browser client. `SUPABASE_ANON_KEY` also accepted |
| `VITE_SUPABASE_URL` | Baked into the client bundle at build time |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Baked into the client bundle at build time |

`VITE_`-prefixed values are inlined into the browser bundle at build time, so
they must be present during `npm run build`, and only non-secret values belong
there.

### Recommended

| Variable | Effect if unset |
| --- | --- |
| `SITE_ORIGIN` | Absolute URLs fall back to `http://localhost:$PORT` |
| `LYRIC_ENGINE_API_KEY` | Lyric generation falls back to `REPLICATE_API_KEY` |
| `MATCHERING_PYTHON` | Interpreter is probed as `python3`, `python`, then `py -3` |
| `MATCHERING_REFERENCE_PATH` | Defaults to `public/references/master_reference.wav`; missing file means loudnorm-only masters |
| `DOWNLOAD_SIGNING_SECRET` | Signed download links unavailable |
| `RESEND_API_KEY`, `RESEND_FROM` | Notification emails are skipped |
| `SLACK_ALERT_WEBHOOK_URL` | Pipeline alerts are not posted |
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | No error reporting |

### Optional overrides

`DEMUCS_MODEL`, `DEMUCS_DEPLOYMENT`, `DEMUCS_HARDWARE` (only for a private
deployment — a public model rejects a hardware SKU with 422),
`FISH_AUDIO_MODEL_TIER`, `FISH_AUDIO_REFERENCE_ID`, `REPLICATE_GEMINI_MODEL`,
`COPRODUCER_REPLICATE_MODEL`, `LOCAL_VAULT_ORIGIN`.

### Do not set

`LOCAL_VAULT_ORIGIN` is a development convenience. In production, configure
Supabase Storage instead so artifacts get signed URLs.

## Database migrations

Apply `supabase/migrations/` before the first deploy. Two are newer than the
running schema and the pipeline depends on both:

- `20260823121800_create_public_generation_tasks.sql` — render status tracking
- `20260823154500_add_user_vault_raw_audio_url.sql` — raw pre-master export

## Pre-deploy checklist

1. `bun run build` (or `npm run build`) succeeds locally and `.output/server/index.mjs` exists.
2. `ffmpeg -version` and `python3 -c "import matchering"` both succeed in the
   deployed container.
3. All required variables above are set in the Railway service.
4. Migrations applied.
5. Trigger one generate and confirm the five gates log in order, ending with
   `[POST-CONDITION PASSED] Mastered audio ready`.
