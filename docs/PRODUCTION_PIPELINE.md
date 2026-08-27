# Production Pipeline Lockdown Checklist

## Architecture map (canonical)

```
[ In-Gate Request ]
       │
       ▼
[ Proactive Flow Enforcer ] ──(Rejects if Maintenance / Backpressure / Velocity limit exceeded)
       │
       ▼
[ Cortex Queue ] ──(FOR UPDATE SKIP LOCKED; token already burned)
       │
       ▼
[ Binary Entanglement Suppressor ] ──(Structured deep-clone & immutable session nonces)
       │
       ▼
[ Detanglement Reactor ] ──(Entropy score check & cross-talk scrubbing)
       │
       ▼
[ Deep Isolation Placement ] ──(Node routing, saturation fallback & audit logging)
       │
       ▼
[ Logistic Map Fluctuator ] ──(Chaotic ±~0.05 organic parameter drift)
       │
       ▼
[ CtxFluctuatorEngine ] ──(Interpretive logic & formula intuition modulation)
       │
       ▼
[ Worker Grid Execution ] ──(Provider synthesis)
       │
       ▼
[ Genre Entitlement Placement ] ──(BPM / stylistic DNA gate)
       │
       ▼
[ Style Influence Enlightment ] ──(Legendary archetype → EQ/sat/reverb signatures)
       │
       ▼
[ BPM Enlinement ] ──(ms bar/beat/16th + sidechain/delay grid)
       │
       ▼
[ Logical Rhythm Enlinement ] ──(Subdivision hierarchy / swing / accents)
       │
       ▼
[ Classical Theory Engine ] ──(Tonic / mode / diatonic triads & roman harmony)
       │
       ▼
[ Musical Ontology & Logic ] ──(Work thickness / compliance norms / expressive contour)
       │
       ▼
[ Recorded Voice Structure Enlinement ] ──(Snap vocal takes to BPM grid + section buses)
       │
       ▼
[ Style & Lyric Enlinement ] ──(Valence / density → vocal + instrumentation)
       │
       ▼
[ Algorithmic Vocal Balance ] ──(Mid-carve + dynamic sidechain ducking lock-in)
       │
       ▼
[ Wierdness Enlinement ] ──(Analog wobble / micro-detune / spectral grit)
       │
       ▼
[ Intuitive Dismantel Placement ] ──(Stem spatial / frequency bus reallocation)
       │
       ▼
[ Music Structure Inlining ] ──(Bar timeline + section transitions)
       │
       ▼
[ Decompression Enlinement ] ──(Section dynamics + -0.3 dB true-peak ceiling)
       │
       ├──► (On Success) ──► [ Ledger Settlement Gate ] ──► Vault & Distribution
       │
       └──► (On Fault)   ──► [ Isolated Ground Connector ] ──► Quarantine Drain
```

**API compression line:** `POST /api/pipeline/master` via `ApiCompressionLine` / `handleMusicApiPost` (Accept-Encoding gzip|deflate → MasterPipelineRunner).
**Verification:** `npm run verify:master-pipeline` (`scripts/verifyMasterPipeline.ts`).

## Canonical master music chain

```
Genre Entitlement (BPM bounds)
  → Style Influence Enlightment (Archival lineage)
  → BPM Enlinement (Millisecond timing grid)
  → Logical Rhythm Enlinement (Subdivision hierarchy / swing / accents)
  → Classical Theory Engine (Tonal architecture / diatonic triads)
  → Musical Ontology & Logic (Work thickness / compliance / expressive contour)
  → Style & Lyric Enlinement (Emotional valence & cadence)
  → Recorded Voice Structure Enlinement (Human vocal take grid-snap & bus assignment)
  → Algorithmic Vocal Balance (Instrumental mid-carve + dynamic sidechain ducking)
  → Wierdness Enlinement (Analog anomalies & tape wobble)
  → Dismantel → Structure → Decompression → Vault & Ledger Settlement Gate
```
**Dry-run composer:** `FullyPluggedCorePipeline.executePluggedCircuit` (perimeter → settlement without live provider).
**Sealed pre-exec:** `WrappedCorePipeline.executeSealedPipeline` (ground-protected preflight → modulate).
**Unified alignment contract:** `SystemAlignmentRunner.runFullyAlignedPipeline` (telemetry + dispatch + settlement dialect).
**Fully integrated master composer:** `MasterPipelineRunner.executeMasterPipeline` (influence → BPM → logical rhythm → classical theory → musical ontology → lyric → recorded voice → vocal balance → wierdness → dismantel → structure → decompression → vault).

## 1. Environment variables

Copy [`.env.example`](../.env.example) → host secrets / `.env.production`.

| Area | Required keys | Notes |
|------|----------------|-------|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Service role is **server-only** |
| Upstream music | `AIMUSICAPI_KEY` (or `MUSICAPI_KEY` / `SHARED_API_KEY`) | Never expose as `VITE_*` |
| Provider | `ACTIVE_GENERATION_PROVIDER` | `hybrid-engine` (default) or `third-party-wrapper` |
| Queue | `GENERATION_QUEUE_WORKER=external` on **web** nodes | Dedicated CLI: `npm run worker:generation-jobs` |
| Throttle | `GENERATION_QUEUE_THROTTLE_MS=3000` | DynamicLogicEngine scales around this base |
| Actuator | `ADMIN_ACTUATOR_SECRET` | Required for POST `/api/system/actuator` |
| Activator | `PIPELINE_MASTER_STATE` (optional) | Overrides DB `system_config` when set |
| App | `NODE_ENV=production`, `NEXT_PUBLIC_APP_URL` | |

**Hard rule:** `DEV_BYPASS_TOKENS` / tokenless generate must be unset or false in production.

## 2. Database migrations (apply in order)

Do **not** replace these with the simplified sketch SQL — the repo migrations already include RLS, vault FK, spend keys, and `FOR UPDATE SKIP LOCKED`.

| Order | File | Purpose |
|------:|------|---------|
| … | Prior token/vault migrations (`spend_hybrid_tokens`, `refund_hybrid_generation_tokens`, `user_vault`) | Atomic burns + refunds + vault RLS |
| 1 | `supabase/migrations/20260827120000_user_vault_select_isolation.sql` | Vault read isolation |
| 2 | `supabase/migrations/20260827140000_generation_queue.sql` | Durable queue + `claim_generation_queue_job()` |
| 3 | `supabase/migrations/20260827143000_generation_jobs_view.sql` | `generation_jobs` view alias |
| 4 | `supabase/migrations/20260827150000_pipeline_telemetry_logs.sql` | Informant audit table |
| 5 | `supabase/migrations/20260827160000_system_config_activator.sql` | Activator Switch (`pipeline_master_state=ARMED`) |
| 6 | `supabase/migrations/20260827170000_pipeline_triggers.sql` | `updated_at` + QUEUE_* audit triggers |
| 7 | `supabase/migrations/20260827171000_consequence_behavior.sql` | `behavioral_throttle_multiplier` + consequence telemetry |
| 8 | `supabase/migrations/20260827172000_reactive_placement.sql` | Reactive placement Informant event |
| 9 | `supabase/migrations/20260827173000_deep_isolation_placement.sql` | `assigned_node` + `DEEP_ISOLATION_PLACEMENT` telemetry |
| 10 | `supabase/migrations/20260827174000_isolated_ground_connector.sql` | `ISOLATED_GROUND_DRAIN_TRIGGERED` telemetry |
| 11 | `supabase/migrations/20260827175000_ledger_settlement_gate.sql` | `LEDGER_SETTLEMENT_COMMITTED` telemetry |
| 12 | `supabase/migrations/20260827176000_telemetry_alignment.sql` | Aligned stage event types (`DISPATCH_ALIGNED`, etc.) |

Apply with your usual Supabase workflow, e.g.:

```bash
npx supabase db push
# or: supabase migration up
```

Verify after apply:

```sql
select key, value from public.system_config where key = 'pipeline_master_state';
-- expect: ARMED

select proname from pg_proc where proname = 'claim_generation_queue_job';
select count(*) from public.generation_queue;
```

## 3. Process topology

```
[Browser] → [Web / TanStack ingress] → Cortex (Activator → In-Gate → Queue)
                                              ↓
                                    generation_queue (pending)
                                              ↓
                         [CLI worker] npm run worker:generation
                         Fluctuator → Provider → End-Gate → user_vault
                                              ↕
                         [Sentinel] npm run sentinel:daemon
                         health → safeguards → flush stuck → Informant
```

- **Web nodes:** `GENERATION_QUEUE_WORKER=external` (or `0`) — never drain jobs on request threads.
- **Worker node:** `npm run worker:generation` (alias: `worker:generation-jobs`).
- **Sentinel:** `npm run sentinel:daemon` — self-healing guardian (`SENTINEL_INTERVAL_MS`, default 30s).
- **Local both:** `npm run production:cluster` (requires `concurrently`).
- **PM2:** `pm2 start ecosystem.config.cjs`

### Flip the master switch

```bash
curl -X POST https://yourdomain.com/api/system/actuator \
  -H "content-type: application/json" \
  -d '{"command":"SET_MAINTENANCE","secretKey":"$ADMIN_ACTUATOR_SECRET"}'

curl -X POST https://yourdomain.com/api/system/actuator \
  -H "content-type: application/json" \
  -d '{"command":"SET_ARMED","secretKey":"$ADMIN_ACTUATOR_SECRET"}'
```

## 4. Pre-flight verification

- [ ] Migrations A–C equivalents above applied; `pipeline_master_state = ARMED`
- [ ] Web has `GENERATION_QUEUE_WORKER=external`; worker process running
- [ ] `spend_hybrid_tokens` / `refund_hybrid_generation_tokens` executable by service role only
- [ ] `user_vault` RLS: users select only `auth.uid() = user_id`
- [ ] Activator returns 503 when set to `MAINTENANCE` / `DISABLED`
- [ ] Actuator health shows pending/processing/failed + `evaluation.status`
- [ ] `LogoutButton` + `AppErrorBoundary` discharge local caches (`installStaticChargeMonitor` in `__root`)
- [ ] No `DEV_BYPASS_TOKENS` in production
- [ ] Informant table `pipeline_telemetry_logs` writable by service role only

## 5. Closed-loop architecture (reference)

| Layer | Role |
|-------|------|
| Activator Switch | Global ARMED / MAINTENANCE / DISABLED |
| Proactive Flow Enforcer | Maintenance / backpressure / free-tier velocity |
| In-Gate | Session identity; blocks DEV bleed; token burn |
| Flux Coating | Zod shields at gate transitions |
| Binary Entanglement + Detanglement | Deep-clone, scrub cross-talk, entropy score |
| Deep Isolation Placement | Node routing, saturation fallback, quarantine |
| Logistic Map + Ctx Fluctuator | Chaotic drift + interpretive / formula modulation |
| Cortex Queue + Worker | Shared-key shock absorber + provider grid |
| Ledger Settlement Gate | Post-vault token audit seal + distribution cue |
| Isolated Ground Connector | Fault / quarantine drain off the hot path |
| End-Gate | Vault delivery + fail-safe refund |
| Informant | Telemetry (enqueue / worker / success / fail / refund / settle / ground) |
| Actuator + Sentinel | Health thresholds, flush hung jobs, trip MAINTENANCE |
| Static Discharger | Logout / expiry / error purge |
| Fully Plugged Core Pipeline | Dry-run perimeter → settlement circuit |
| Wrapped Core Pipeline | Ground-protected sealed pre-execution path |
| System Alignment Runner | Unified aligned contract (telemetry + dispatch + settlement) |
| Master Pipeline Runner | Fully integrated music closed loop (recorded voice → vault) |
| Telemetry Alignment | Uniform stage dialect for Informant audit logs |
| Dispatch Alignment | Sealed-core → provider schema boundary |
| Genre Entitlement Placement | BPM / genre DNA gate before music alignment |
| Style Influence Enlightment | Legendary archetype → EQ / sat / reverb signatures |
| BPM Enlinement | Master tempo → ms grid (bar/beat/16th/sidechain) |
| Recorded Voice Structure Enlinement | Snap vocal takes to BPM grid + section buses |
| Style & Lyric Enlinement | Emotional valence / density → vocal + instrument presets |
| Wierdness Enlinement | Controlled analog anomalies from chaos factor |
| Intuitive Dismantel Placement | Post-synth stem spatial / frequency bus reallocation |
| Music Structure Inlining | Master bar timeline + section transition lock |
| Decompression Enlinement | Section dynamics + -0.3 dB true-peak ceiling |
