/**
 * Sequential generation-jobs worker (table: public.generation_queue).
 *
 * Isolated from HTTP ingress: polls pending jobs, processes one at a time
 * against the shared upstream API key, settles user_vault to job.user_id,
 * and refunds tokens on any failure.
 */

import type { GenerationQueueRow } from "@/lib/generation-queue.server";

/** Poll interval when the queue is empty. */
export const GENERATION_QUEUE_POLL_MS = Math.max(
  1_000,
  Number.parseInt(process.env.GENERATION_QUEUE_POLL_MS ?? "2500", 10) || 2500,
);

/** Minimum gap between starting two upstream generations (shared API key). */
export const GENERATION_QUEUE_THROTTLE_MS = Math.max(
  0,
  Number.parseInt(process.env.GENERATION_QUEUE_THROTTLE_MS ?? "3000", 10) || 3000,
);

/** Opt-out in-process drain: GENERATION_QUEUE_WORKER=0 (use scripts/generation-jobs-worker.ts). */
function workerEnabled(): boolean {
  const v = process.env.GENERATION_QUEUE_WORKER;
  if (v === "0" || v === "false" || v === "external") return false;
  return true;
}

let installed = false;
let running = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpstreamStartAt = 0;
let cachedPendingCount = 0;
let pendingCountCheckedAt = 0;

async function refreshPendingCount(): Promise<number> {
  const now = Date.now();
  if (now - pendingCountCheckedAt < 2_000) return cachedPendingCount;
  try {
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (!admin) return cachedPendingCount;
    const { count } = await admin
      .from("generation_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    cachedPendingCount = count ?? 0;
    pendingCountCheckedAt = now;
  } catch {
    /* keep last known */
  }
  return cachedPendingCount;
}

export function ensureGenerationQueueWorkerInstalled(): void {
  if (installed || !workerEnabled()) return;
  installed = true;
  console.info("[generation-jobs-worker] installed (in-process)", {
    pollMs: GENERATION_QUEUE_POLL_MS,
    throttleMs: GENERATION_QUEUE_THROTTLE_MS,
  });
  scheduleTick(500);
}

export function kickGenerationQueueWorker(): void {
  ensureGenerationQueueWorkerInstalled();
  if (!workerEnabled()) return;
  scheduleTick(0);
}

/** Actuator / health probe — never exposes job payloads. */
export function getGenerationQueueWorkerStatus(): {
  enabled: boolean;
  installed: boolean;
  running: boolean;
  lastUpstreamStartAt: number;
} {
  return {
    enabled: workerEnabled(),
    installed,
    running,
    lastUpstreamStartAt,
  };
}

/**
 * One drain cycle — used by the isolated CLI worker and in-process poller.
 * Returns true when a job was claimed/processed.
 */
export async function drainOneGenerationJob(): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    // Respect master activator — do not claim while disarmed / maintenance.
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    const switchStatus = await PipelineActivatorSwitch.verifySystemArmed();
    if (!switchStatus.armed) {
      return false;
    }

    const claimed = await claimNextJob();
    if (!claimed) return false;

    const pending = await refreshPendingCount();
    const { DynamicLogicEngine } = await import("@/lib/DynamicLogicEngine");
    const { ConsequenceBehaviorEngine } = await import("@/lib/ConsequenceBehaviorEngine");
    const behavioralMultiplier = await ConsequenceBehaviorEngine.refreshThrottleMultiplier();
    const adaptiveThrottle = DynamicLogicEngine.calculateAdaptiveThrottle(
      pending,
      GENERATION_QUEUE_THROTTLE_MS,
      behavioralMultiplier,
    );
    const wait = adaptiveThrottle - (Date.now() - lastUpstreamStartAt);
    if (wait > 0) await sleep(wait);
    lastUpstreamStartAt = Date.now();

    await processClaimedJob(claimed, DynamicLogicEngine.queueLoadFactor(pending));
    return true;
  } finally {
    running = false;
  }
}

/** Blocking forever-loop for `scripts/generation-jobs-worker.ts`. */
export async function runGenerationJobsWorkerForever(): Promise<never> {
  console.info("[generation-jobs-worker] starting isolated loop", {
    pollMs: GENERATION_QUEUE_POLL_MS,
    throttleMs: GENERATION_QUEUE_THROTTLE_MS,
  });
  for (;;) {
    try {
      const worked = await drainOneGenerationJob();
      if (!worked) await sleep(GENERATION_QUEUE_POLL_MS);
    } catch (error) {
      console.error(
        "[generation-jobs-worker] loop error",
        error instanceof Error ? error.message : error,
      );
      await sleep(GENERATION_QUEUE_POLL_MS);
    }
  }
}

function scheduleTick(delayMs: number): void {
  if (!workerEnabled()) return;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void tick().catch((error) => {
      console.error(
        "[generation-jobs-worker] tick failed",
        error instanceof Error ? error.message : error,
      );
      scheduleTick(GENERATION_QUEUE_POLL_MS);
    });
  }, Math.max(0, delayMs));
}

async function tick(): Promise<void> {
  if (!workerEnabled()) return;
  const worked = await drainOneGenerationJob();
  if (worked) {
    scheduleTick(0);
    return;
  }
  const pending = await refreshPendingCount();

  // Periodic safeguard probe (empty-queue ticks) — trips MAINTENANCE on CRITICAL fails.
  try {
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (admin) {
      const [{ count: processing }, { count: failed }] = await Promise.all([
        admin
          .from("generation_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "processing"),
        admin
          .from("generation_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed"),
      ]);
      const { PipelineTriggerOrchestrator } = await import(
        "@/lib/PipelineTriggerOrchestrator"
      );
      await PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards({
        pendingJobs: pending,
        processingJobs: processing ?? 0,
        failedJobCount: failed ?? 0,
      });
    }
  } catch {
    /* never block the poller on safeguard errors */
  }

  const { DynamicLogicEngine } = await import("@/lib/DynamicLogicEngine");
  const pollMs = DynamicLogicEngine.calculateAdaptivePoll(pending, GENERATION_QUEUE_POLL_MS);
  scheduleTick(pollMs);
}

async function claimNextJob(): Promise<GenerationQueueRow | null> {
  const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = tryGetSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin.rpc("claim_generation_queue_job");
  if (error) {
    console.error("[generation-jobs-worker] claim RPC failed", error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as GenerationQueueRow | null | undefined;
  return row?.id ? row : null;
}

async function processClaimedJob(
  job: GenerationQueueRow,
  queueLoadFactor = 0,
): Promise<void> {
  const { PipelineFluxCoating, FluxRejectionError } = await import("@/lib/PipelineFluxCoating");

  // Flux Coating: reject contaminated queue rows before any side effects.
  let coatedJob: ReturnType<typeof PipelineFluxCoating.coatQueueJob>;
  try {
    coatedJob = PipelineFluxCoating.coatQueueJob(job);
  } catch (error) {
    console.error(
      "[generation-jobs-worker] flux rejected queue row",
      error instanceof Error ? error.message : error,
    );
    // Cannot safely refund without a verified user_id — abandon claim cleanup via End-Gate only when ids look usable.
    if (job?.id && job?.user_id) {
      const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");
      await EndGateDispatcher.handleDeliveryFailure({
        jobId: job.id,
        userId: job.user_id,
        errorMessage:
          error instanceof Error
            ? error.message
            : "Flux Rejection: contaminated queue job row.",
        spendIdempotencyKey: job.spend_idempotency_key,
        vaultId: job.vault_id,
      });
    }
    return;
  }

  const ownerId = coatedJob.user_id;
  const startTime = Date.now();
  const promptPayloadBytes = (() => {
    try {
      return JSON.stringify(coatedJob.prompt_payload ?? {}).length;
    } catch {
      return 0;
    }
  })();

  // 1. INITIALIZE CTX — sealed immutable envelope for this job (no loose identity).
  const correlationIdHint =
    typeof (coatedJob.prompt_payload as { cortexCorrelationId?: unknown })?.cortexCorrelationId ===
    "string"
      ? (coatedJob.prompt_payload as { cortexCorrelationId: string }).cortexCorrelationId
      : undefined;
  const { ContextFactory, ContextRejectionError } = await import("@/lib/ExecutionContext");
  let ctx: ReturnType<typeof ContextFactory.createFromQueueJob>;
  try {
    ctx = ContextFactory.createFromQueueJob({
      userId: ownerId,
      jobId: coatedJob.id,
      tier: "free",
      correlationId: correlationIdHint,
    });
  } catch (error) {
    console.error(
      "[generation-jobs-worker] CTX rejected",
      error instanceof Error ? error.message : error,
    );
    const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");
    await EndGateDispatcher.handleDeliveryFailure({
      jobId: coatedJob.id,
      userId: ownerId,
      errorMessage:
        error instanceof Error ? error.message : "CTX Rejection: invalid execution context.",
      spendIdempotencyKey: coatedJob.spend_idempotency_key,
      vaultId: coatedJob.vault_id,
    });
    return;
  }

  console.info("[generation-jobs-worker] processing", {
    jobId: coatedJob.id,
    userId: ctx.userId,
    requestId: ctx.requestId,
    vaultId: coatedJob.vault_id,
  });

  // INFORMANT: worker start stamped with CTX requestId + nonce.
  const { PipelineInformant } = await import("@/lib/PipelineInformant");
  await PipelineInformant.recordTelemetry({
    eventType: "WORKER_START",
    jobId: coatedJob.id,
    userId: ctx.userId,
    metadata: {
      requestId: ctx.requestId,
      nonce: ctx.sessionNonce,
      sourceGate: ctx.sourceGate,
      vaultId: coatedJob.vault_id,
      promptPayloadBytes,
      startedAt: coatedJob.started_at,
    },
  });

  // Binary entanglement suppression — orthogonalize queue blob before worker logic.
  const { BinaryEntanglementSuppressor, executeIsolatedWorkerTask } = await import(
    "@/lib/BinaryEntanglementSuppressor"
  );
  const isolated = executeIsolatedWorkerTask(ctx, {
    jobId: coatedJob.id,
    userId: ctx.userId,
    vaultId: coatedJob.vault_id,
    spendIdempotencyKey: coatedJob.spend_idempotency_key,
    prompt_payload:
      coatedJob.prompt_payload && typeof coatedJob.prompt_payload === "object"
        ? (coatedJob.prompt_payload as Record<string, unknown>)
        : { value: coatedJob.prompt_payload },
  });
  const isolatedPromptPayload = isolated.processedData.prompt_payload;

  const { TelemetryAlignment, logReactorCheckpoint } = await import("@/lib/TelemetryAlignment");
  TelemetryAlignment.emit(ctx, {
    eventType: "BINARY_SUPPRESSION_APPLIED",
    status: "SUCCESS",
    details: {
      jobId: coatedJob.id,
      entanglementState: isolated.processedData.__entanglementState ?? "SUPPRESSED_ORTHOGONAL",
    },
  });

  const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = tryGetSupabaseAdmin();
  if (!admin) {
    const message = "Service role unavailable for generation-jobs worker.";
    await PipelineInformant.recordTelemetry({
      eventType: "GENERATION_FAILURE",
      jobId: coatedJob.id,
      userId: ctx.userId,
      metadata: {
        error: message,
        durationMs: Date.now() - startTime,
        requestId: ctx.requestId,
      },
    });
    const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");
    await EndGateDispatcher.handleDeliveryFailure({
      jobId: coatedJob.id,
      userId: ctx.userId,
      errorMessage: message,
      spendIdempotencyKey: coatedJob.spend_idempotency_key,
      vaultId: coatedJob.vault_id,
    });
    if (coatedJob.spend_idempotency_key) {
      await PipelineInformant.recordTelemetry({
        eventType: "TOKEN_REFUND",
        jobId: coatedJob.id,
        userId: ctx.userId,
        metadata: { reason: "service_role_unavailable", requestId: ctx.requestId },
      });
    }
    return;
  }

  try {
    const { GenerationFactory } = await import("@/lib/generation-providers/GenerationFactory");

    // Flux Coating: re-verify In-Gate studio payload from the *isolated* queue blob.
    const coatedStudio = PipelineFluxCoating.coatInGate(isolatedPromptPayload);
    // Defense in depth: ensure coatInGate output is also reference-decoupled from queue row.
    const isolatedStudio = BinaryEntanglementSuppressor.suppressCrossTalk(
      ctx,
      coatedStudio as unknown as Record<string, unknown>,
    );
    if (
      !BinaryEntanglementSuppressor.verifyDecoupling(
        coatedJob.prompt_payload,
        isolatedStudio,
      )
    ) {
      throw new Error("Entanglement Suppression Failure: payload still coupled to queue row.");
    }

    // Deep Isolation Placement — detangle, saturate-check, assign secure cluster.
    const { dispatchToSecureCore } = await import("@/lib/DeepIsolationPlacement");
    const secured = await dispatchToSecureCore(
      ctx,
      isolatedStudio as unknown as Record<string, unknown>,
    );
    const reactorLog = secured.reactorState;
    const correlationId = correlationIdHint ?? ctx.requestId;
    const studioPayload = secured.payload as unknown as typeof coatedStudio;

    // Persist logical cluster assignment for saturation accounting.
    try {
      await admin
        .from("generation_queue")
        .update({
          assigned_node: secured.node,
          updated_at: new Date().toISOString(),
        })
        .eq("id", coatedJob.id)
        .eq("status", "processing");
    } catch (assignErr) {
      console.warn(
        "[generation-jobs-worker] assigned_node stamp failed",
        assignErr instanceof Error ? assignErr.message : assignErr,
      );
    }

    if (secured.securityVerdict === "FALLBACK_ROUTED") {
      console.warn("[DEEP ISOLATION] fallback routed to standby overflow", {
        jobId: coatedJob.id,
        requestId: ctx.requestId,
        node: secured.node,
      });
    }

    if (reactorLog.aggressiveDampening) {
      console.warn("[DETANGLEMENT REACTOR] aggressive dampening engaged", {
        jobId: coatedJob.id,
        requestId: ctx.requestId,
        entropyScore: reactorLog.entropyScore,
        entanglementLevel: reactorLog.entanglementLevel,
      });
    }

    // ABSTRACT LAYER: active provider (shared upstream key drained sequentially).
    const provider = GenerationFactory.getProvider();
    console.info("[generation-jobs-worker] provider selected", {
      jobId: coatedJob.id,
      provider: provider.name,
      requestId: ctx.requestId,
      reactorNonce: secured.nonce,
      targetClusterNode: secured.node,
      isolationLevel: secured.isolationLevel,
      securityVerdict: secured.securityVerdict,
    });

    const genre = (studioPayload.genre || studioPayload.style || studioPayload.prompt).trim();

    // 2. PASS CTX INTO FLUCTUATOR — identity/tier/nonce only from sealed context.
    const { CtxFluctuatorEngine } = await import("@/lib/CtxFluctuatorEngine");
    const modulated = CtxFluctuatorEngine.modulate(ctx, genre || studioPayload.prompt, {
      queueLoadFactor,
      title: studioPayload.title,
      style: genre,
    });
    const coatedModulation = PipelineFluxCoating.coatFluctuated(modulated.envelope);
    ContextFactory.assertOwner(ctx, coatedModulation.parameters.targetUserUuid);

    // Dispatch Alignment — seal core modulation into strict provider schema.
    const { DispatchAlignment } = await import("@/lib/DispatchAlignment");
    const prefs = (
      coatedModulation as {
        profileSnapshot?: {
          preferences?: { intuitiveStateFluctuator?: { organicDrift?: number } };
        };
      }
    ).profileSnapshot?.preferences?.intuitiveStateFluctuator;
    const organicDrift =
      typeof prefs?.organicDrift === "number" ? prefs.organicDrift : 0;
    const providerDispatch = DispatchAlignment.alignToProviderSchema(
      ctx,
      {
        trackTitle: studioPayload.title,
        title: studioPayload.title,
        genre,
        style: studioPayload.style,
        prompt: modulated.modulatedPrompt || studioPayload.prompt,
        durationSeconds: studioPayload.durationSeconds,
        temperature: coatedModulation.parameters.temperature,
        styleWeight: coatedModulation.parameters.styleWeight,
        organicDrift,
        parameters: {
          temperature: coatedModulation.parameters.temperature,
          styleWeight: coatedModulation.parameters.styleWeight,
        },
      },
      secured.node,
    );

    await logReactorCheckpoint(
      ctx,
      reactorLog.entanglementLevel,
      secured.securityVerdict === "QUARANTINED",
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "CHAOTIC_FLUCTUATION_APPLIED",
      status: "SUCCESS",
      details: {
        temperature: coatedModulation.parameters.temperature,
        styleWeight: coatedModulation.parameters.styleWeight,
        organicDrift,
        fluctuationNonce: modulated.fluctuationNonce,
      },
    });
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: {
        targetNode: secured.node,
        trackTitle: providerDispatch.trackTitle,
        providerPayloadKeys: Object.keys(providerDispatch),
      },
    });

    // Bind modulated controls onto the studio payload (never a static global).
    const controls = {
      ...(studioPayload.controls ?? {
        bpm: 120,
        influence: 50,
        weirdness: 50,
        styleInfluence: 50,
      }),
      ...(typeof coatedModulation.parameters.styleInfluence === "number"
        ? { styleInfluence: coatedModulation.parameters.styleInfluence }
        : {}),
      ...(typeof coatedModulation.parameters.weirdness === "number"
        ? { weirdness: coatedModulation.parameters.weirdness }
        : {}),
    };

    const fluctuatedStudioPayload = {
      ...studioPayload,
      prompt: modulated.modulatedPrompt || studioPayload.prompt,
      title: providerDispatch.trackTitle,
      genre: providerDispatch.genreVector,
      durationSeconds: providerDispatch.durationSeconds,
      controls,
      cortexCorrelationId: correlationId,
      fluctuationNonce: modulated.fluctuationNonce,
      targetUserUuid: ctx.userId,
      providerDispatch,
      executionContext: {
        requestId: ctx.requestId,
        sessionNonce: ctx.sessionNonce,
        tier: ctx.tier,
        sourceGate: ctx.sourceGate,
        timestamp: ctx.timestamp,
        jobId: ctx.jobId ?? coatedJob.id,
      },
      detanglementReactor: reactorLog,
      deepIsolationPlacement: {
        targetClusterNode: secured.node,
        isolationLevel: secured.isolationLevel,
        reactorNonce: secured.nonce,
        securityVerdict: secured.securityVerdict,
      },
    };

    // 3. EXECUTE GENERATION — userId strictly from CTX; schema aligned via DispatchAlignment.
    const result = await provider.generateTrack({
      prompt: modulated.modulatedPrompt,
      userId: ctx.userId,
      options: {
        studioPayload: fluctuatedStudioPayload,
        supabase: admin,
        title: providerDispatch.trackTitle,
        lyrics: studioPayload.lyrics,
        instrumental: studioPayload.instrumental,
        genre: providerDispatch.genreVector,
        style: studioPayload.style || providerDispatch.genreVector,
        durationSeconds: providerDispatch.durationSeconds,
        tags: studioPayload.tags,
        vocalGender: studioPayload.vocalGender,
        voiceId: studioPayload.voiceId,
        referenceAudioUrl: studioPayload.referenceAudioUrl,
        vaultId: coatedJob.vault_id ?? studioPayload.vaultId,
        fluctuation: coatedModulation,
        providerDispatch,
        acousticParameters: providerDispatch.acousticParameters,
        executionContext: ctx,
      },
    });

    if (!result.audioUrl?.trim()) {
      throw new Error("Provider completed without a playable audio URL.");
    }

    // 3a. GENRE ENTITLEMENT — verify BPM / stylistic DNA before alignment burn.
    const { GenreEntitlementPlacement } = await import("@/lib/GenreEntitlementPlacement");
    const controlsBpm =
      studioPayload.controls &&
      typeof studioPayload.controls === "object" &&
      typeof (studioPayload.controls as { bpm?: unknown }).bpm !== "undefined"
        ? (studioPayload.controls as { bpm?: unknown }).bpm
        : undefined;
    const targetGenre = GenreEntitlementPlacement.resolveSupportedGenre(
      studioPayload.genre || studioPayload.style || genre || studioPayload.prompt,
    );
    const currentBpm = GenreEntitlementPlacement.resolveBpm(controlsBpm, targetGenre);
    const genreEntitlement = GenreEntitlementPlacement.verifyAndEnforceEntitlement(
      ctx,
      targetGenre,
      currentBpm,
    );
    if (genreEntitlement.entitlementStatus === "GENRE_MISMATCH_QUARANTINED") {
      throw new Error(
        `[SECURITY HALT] Genre entitlement mismatch for ${genreEntitlement.genreVerified} at ${currentBpm} BPM (allowed ${genreEntitlement.appliedRules.requiredBpmRange[0]}-${genreEntitlement.appliedRules.requiredBpmRange[1]}).`,
      );
    }
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: {
        stage: "GENRE_ENTITLEMENT",
        entitlementId: genreEntitlement.entitlementId,
        genreVerified: genreEntitlement.genreVerified,
        currentBpm,
        subBassRouting: genreEntitlement.appliedRules.subBassRouting,
        masterLufsTarget: genreEntitlement.appliedRules.masterLufsTarget,
      },
    });

    // 3a0. STYLE INFLUENCE ENLIGHTMENT — legendary archetype → mix signatures.
    const { StyleInfluenceEnlightment } = await import("@/lib/StyleInfluenceEnlightment");
    const influenceArchetype = StyleInfluenceEnlightment.resolveArchetype({
      genre: genreEntitlement.genreVerified,
      styleHint: studioPayload.style || studioPayload.genre,
      promptHint: studioPayload.prompt || genre,
    });
    const styleInfluence = StyleInfluenceEnlightment.enlighteneStyleInfluence(
      ctx,
      influenceArchetype,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: styleInfluence.enlightmentCoherenceScore < 0.96 ? "WARNING" : "SUCCESS",
      details: {
        stage: "STYLE_INFLUENCE_ENLIGHTMENT",
        influenceBlueprintId: styleInfluence.influenceBlueprintId,
        archetype: styleInfluence.archetype,
        enlightmentCoherenceScore: styleInfluence.enlightmentCoherenceScore,
        sonicSignatures: styleInfluence.sonicSignatures,
      },
    });

    // 3a1. BPM ENLINEMENT — master tempo → millisecond timing grid.
    const { BpmEnlinement } = await import("@/lib/BpmEnlinement");
    const timeSigNum =
      studioPayload.controls &&
      typeof studioPayload.controls === "object" &&
      typeof (studioPayload.controls as { timeSignatureNumerator?: unknown })
        .timeSignatureNumerator === "number"
        ? (studioPayload.controls as { timeSignatureNumerator: number }).timeSignatureNumerator
        : 4;
    const timeSigDen =
      studioPayload.controls &&
      typeof studioPayload.controls === "object" &&
      typeof (studioPayload.controls as { timeSignatureDenominator?: unknown })
        .timeSignatureDenominator === "number"
        ? (studioPayload.controls as { timeSignatureDenominator: number }).timeSignatureDenominator
        : 4;
    const bpmTiming = BpmEnlinement.enlineBpmGrid(ctx, {
      masterBpm: currentBpm,
      timeSignatureNumerator: timeSigNum,
      timeSignatureDenominator: timeSigDen,
    });
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: {
        stage: "BPM_ENLINEMENT",
        bpmBlueprintId: bpmTiming.bpmBlueprintId,
        masterBpm: bpmTiming.masterBpm,
        barDurationMs: bpmTiming.barDurationMs,
        sixteenthNoteMs: bpmTiming.sixteenthNoteMs,
        sidechainReleaseMs: bpmTiming.sidechainReleaseMs,
      },
    });

    // 3a1a. LOGICAL RHYTHM ENLINEMENT — subdivision hierarchy / swing / accents.
    const { LogicalRhythmEnlinement } = await import("@/lib/LogicalRhythmEnlinement");
    const rhythmPattern = LogicalRhythmEnlinement.deriveRhythmPatternInput({
      bpmTiming,
      chaosFactor: organicDrift,
      controls: studioPayload.controls,
      syncopationThreshold:
        studioPayload.controls &&
        typeof studioPayload.controls === "object" &&
        typeof (studioPayload.controls as { syncopation?: unknown }).syncopation !== "undefined"
          ? (studioPayload.controls as { syncopation?: unknown }).syncopation
          : undefined,
    });
    const rhythmBlueprint = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, rhythmPattern);
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: rhythmBlueprint.rhythmCoherenceScore < 0.975 ? "WARNING" : "SUCCESS",
      details: {
        stage: "LOGICAL_RHYTHM_ENLINEMENT",
        rhythmBlueprintId: rhythmBlueprint.rhythmBlueprintId,
        swingFactor: rhythmBlueprint.swingFactor,
        accentPositions: rhythmBlueprint.accentPositions,
        subdivisionHierarchy: rhythmBlueprint.subdivisionHierarchy,
        rhythmCoherenceScore: rhythmBlueprint.rhythmCoherenceScore,
      },
    });

    // 3a1a2. CLASSICAL THEORY ENGINE — tonic / mode / diatonic triads.
    const { ClassicalTheoryEngine } = await import("@/lib/ClassicalTheoryEngine");
    const derivedHarmony = ClassicalTheoryEngine.deriveTonicAndMode({
      genreArchetype: influenceArchetype,
      tonicHint: studioPayload.tonicNote ?? studioPayload.key,
      modeHint: studioPayload.scaleMode ?? studioPayload.mode,
      keyHint: studioPayload.key ?? studioPayload.musicalKey,
      genreHint: studioPayload.genre || studioPayload.style || genre,
    });
    const theoryBlueprint = ClassicalTheoryEngine.deriveClassicalHarmonics(
      ctx,
      derivedHarmony.tonic,
      derivedHarmony.mode,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: theoryBlueprint.theoryCoherenceIndex < 0.988 ? "WARNING" : "SUCCESS",
      details: {
        stage: "CLASSICAL_THEORY_ENGINE",
        theoryEngineId: theoryBlueprint.theoryEngineId,
        tonicNote: theoryBlueprint.tonicNote,
        mode: theoryBlueprint.mode,
        triadCount: theoryBlueprint.diatonicTriads.length,
        theoryCoherenceIndex: theoryBlueprint.theoryCoherenceIndex,
        romans: theoryBlueprint.diatonicTriads.map((t) => t.roman),
      },
    });

    // 3a1a3. MUSICAL ONTOLOGY & LOGIC — thickness / compliance / expressive contour.
    const { MusicalOntologyAndLogicEngine } = await import(
      "@/lib/MusicalOntologyAndLogicEngine"
    );
    const { StyleLyricEnlinement: StyleLyricForOntology } = await import(
      "@/lib/StyleLyricEnlinement"
    );
    const ontologyLyricSegments = StyleLyricForOntology.deriveSegmentsFromStudioPayload({
      ctx,
      lyrics: studioPayload.lyrics,
      genreHint: studioPayload.genre || studioPayload.style || genre,
      instrumental: Boolean(studioPayload.instrumental),
    });
    const philosophyInput = MusicalOntologyAndLogicEngine.derivePhilosophyLogicInput({
      genreArchetype: influenceArchetype,
      lyricSegments: ontologyLyricSegments,
      workTypeHint: studioPayload.workOntologyType,
      listeningModeHint: studioPayload.listeningMode,
      expressiveValenceHint: studioPayload.expressiveValence,
      genreHint: studioPayload.genre || studioPayload.style || genre,
    });
    const philosophyBlueprint = MusicalOntologyAndLogicEngine.evaluateMusicalLogic(
      ctx,
      philosophyInput,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status:
        philosophyBlueprint.structuralCoherenceVerdict === "REQUIRES_CONTEXT_ANCHOR"
          ? "WARNING"
          : "SUCCESS",
      details: {
        stage: "MUSICAL_ONTOLOGY_AND_LOGIC",
        ontologyEngineId: philosophyBlueprint.ontologyEngineId,
        enforcedComplianceNorm: philosophyBlueprint.enforcedComplianceNorm,
        ontologicalThicknessScore: philosophyBlueprint.ontologicalThicknessScore,
        expressiveContourMatchIndex: philosophyBlueprint.expressiveContourMatchIndex,
        structuralCoherenceVerdict: philosophyBlueprint.structuralCoherenceVerdict,
        philosophyCoherenceIndex: philosophyBlueprint.philosophyCoherenceIndex,
      },
    });

    // 3a1b. RECORDED VOICE STRUCTURE ENLINEMENT — snap vocals to BPM grid.
    const { RecordedVoiceStructureEnlinement } = await import(
      "@/lib/RecordedVoiceStructureEnlinement"
    );
    const derivedVocalTake = RecordedVoiceStructureEnlinement.deriveTakeFromStudioPayload({
      ctx,
      bpmTiming,
      voiceId: studioPayload.voiceId,
      referenceAudioUrl: studioPayload.referenceAudioUrl,
      durationSeconds: studioPayload.durationSeconds ?? providerDispatch.durationSeconds,
      lyrics: studioPayload.lyrics,
      instrumental: Boolean(studioPayload.instrumental),
      hasVocalStem: Boolean(result.vocalUrl?.trim()),
    });
    const recordedVoiceAlignments = derivedVocalTake
      ? [
          RecordedVoiceStructureEnlinement.enlineRecordedVocal(
            ctx,
            derivedVocalTake,
            bpmTiming.masterBpm,
          ),
        ]
      : [];
    if (recordedVoiceAlignments.length > 0) {
      TelemetryAlignment.emit(ctx, {
        eventType: "DISPATCH_ALIGNED",
        status:
          recordedVoiceAlignments.some((a) => a.structuralFitVerdict === "REQUIRES_TIME_STRETCH")
            ? "WARNING"
            : "SUCCESS",
        details: {
          stage: "RECORDED_VOICE_STRUCTURE_ENLINEMENT",
          alignmentCount: recordedVoiceAlignments.length,
          verdicts: recordedVoiceAlignments.map((a) => a.structuralFitVerdict),
          buses: recordedVoiceAlignments.map((a) => a.assignedBusRouting),
        },
      });
    }

    // 3a2. STYLE & LYRIC ENLINEMENT — emotional valence → vocal/instrument density.
    const { StyleLyricEnlinement } = await import("@/lib/StyleLyricEnlinement");
    const lyricSegments = StyleLyricEnlinement.deriveSegmentsFromStudioPayload({
      ctx,
      lyrics: studioPayload.lyrics,
      genreHint: studioPayload.genre || studioPayload.style || genre,
      instrumental: Boolean(studioPayload.instrumental),
    });
    const lyricEnlinement = StyleLyricEnlinement.enlineLyricsWithStyle(ctx, lyricSegments);
    TelemetryAlignment.emit(ctx, {
      eventType: "CHAOTIC_FLUCTUATION_APPLIED",
      status: lyricEnlinement.lyricStyleCoherenceScore < 0.94 ? "WARNING" : "SUCCESS",
      details: {
        stage: "STYLE_LYRIC_ENLINEMENT",
        lyricBlueprintId: lyricEnlinement.lyricBlueprintId,
        lyricStyleCoherenceScore: lyricEnlinement.lyricStyleCoherenceScore,
        profileCount: lyricEnlinement.synchronizedArrangementProfiles.length,
        presets: lyricEnlinement.synchronizedArrangementProfiles.map(
          (p) => p.vocalProcessingPreset,
        ),
      },
    });

    // 3a2b. ALGORITHMIC VOCAL BALANCE — mid-carve + dynamic sidechain ducking.
    const { AlgorithmicVocalBalance } = await import("@/lib/AlgorithmicVocalBalance");
    const vocalBalanceInput = AlgorithmicVocalBalance.deriveVocalBalanceInput({
      lyricEnlinement,
      vocalAlignments: recordedVoiceAlignments,
      instrumental: Boolean(studioPayload.instrumental),
      vocalPeakRmsDb: studioPayload.vocalPeakRmsDb,
      vocalFundamentalHz: studioPayload.vocalFundamentalHz,
      emotionalIntensity: studioPayload.emotionalIntensity,
    });
    const vocalBalance = AlgorithmicVocalBalance.balanceVocals(ctx, vocalBalanceInput);
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: vocalBalance.masterpieceCoherenceIndex < 0.97 ? "WARNING" : "SUCCESS",
      details: {
        stage: "ALGORITHMIC_VOCAL_BALANCE",
        balanceBlueprintId: vocalBalance.balanceBlueprintId,
        dynamicSidechainDuckingDb: vocalBalance.dynamicSidechainDuckingDb,
        instrumentalMidCarveHz: vocalBalance.instrumentalMidCarveHz,
        instrumentalMidCarveDepthDb: vocalBalance.instrumentalMidCarveDepthDb,
        harmonicBlendRatio: vocalBalance.harmonicBlendRatio,
        masterpieceCoherenceIndex: vocalBalance.masterpieceCoherenceIndex,
      },
    });

    // 3a3. WIERDNESS ENLINEMENT — controlled analog anomalies from chaos factor.
    const { WierdnessEnlinement } = await import("@/lib/WierdnessEnlinement");
    const controlsWeirdness =
      studioPayload.controls &&
      typeof studioPayload.controls === "object" &&
      typeof (studioPayload.controls as { weirdness?: unknown }).weirdness !== "undefined"
        ? (studioPayload.controls as { weirdness?: unknown }).weirdness
        : coatedModulation.parameters.weirdness;
    const chaosFactor = WierdnessEnlinement.resolveChaosFactor({
      weirdness: controlsWeirdness,
      organicDrift,
      acousticChaosDrift: providerDispatch.acousticParameters.chaosDrift,
    });
    const wierdnessTarget = WierdnessEnlinement.resolveTargetElement({
      instrumental: Boolean(studioPayload.instrumental),
      hasVocal: Boolean(result.vocalUrl?.trim()) || !studioPayload.instrumental,
      genreHint: studioPayload.genre || studioPayload.style || genre,
    });
    const wierdness = WierdnessEnlinement.enlineWierdness(ctx, {
      chaosFactor,
      targetElement: wierdnessTarget,
    });
    TelemetryAlignment.emit(ctx, {
      eventType: "CHAOTIC_FLUCTUATION_APPLIED",
      status:
        wierdness.wierdnessVerdict === "RADICAL_ALTERATION" ? "WARNING" : "SUCCESS",
      details: {
        stage: "WIERDNESS_ENLINEMENT",
        wierdnessBlueprintId: wierdness.wierdnessBlueprintId,
        appliedChaosFactor: wierdness.appliedChaosFactor,
        wierdnessVerdict: wierdness.wierdnessVerdict,
        targetElement: wierdness.targetElement,
        anomalyParameters: wierdness.anomalyParameters,
      },
    });

    // 3b. INTUITIVE DISMANTEL — reallocates stems across spatial / frequency buses.
    const { IntuitiveDismantelPlacement } = await import("@/lib/IntuitiveDismantelPlacement");
    const rawStems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
      ctx,
      hasMaster: Boolean(result.audioUrl?.trim()),
      hasInstrumental: Boolean(result.instrumentalUrl?.trim()),
      hasVocal: Boolean(result.vocalUrl?.trim()),
      hasRaw: Boolean(result.rawAudioUrl?.trim()),
    });
    let dismantel = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, rawStems);
    dismantel = IntuitiveDismantelPlacement.applyGenreSubBassRouting(
      dismantel,
      genreEntitlement.appliedRules.subBassRouting,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "CHAOTIC_FLUCTUATION_APPLIED",
      status: dismantel.harmonicBalanceScore < 0.88 ? "WARNING" : "SUCCESS",
      details: {
        stage: "INTUITIVE_DISMANTEL_PLACEMENT",
        restructuredArrangementId: dismantel.restructuredArrangementId,
        harmonicBalanceScore: dismantel.harmonicBalanceScore,
        stemCount: dismantel.reallocatedStems.length,
        buses: dismantel.reallocatedStems.map((s) => s.assignedSpatialBus),
        genreSubBassRouting: genreEntitlement.appliedRules.subBassRouting,
      },
    });

    // 3c. MUSIC STRUCTURE INLINING — lock stems onto a master bar timeline.
    const { MusicStructureInlining } = await import("@/lib/MusicStructureInlining");
    const arrangementBlocks = MusicStructureInlining.deriveBlocksFromDismantel(ctx, dismantel);
    const inlinedStructure = MusicStructureInlining.inlineArrangementStructure(
      ctx,
      arrangementBlocks,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: {
        stage: "MUSIC_STRUCTURE_INLINING",
        timelineBlueprintId: inlinedStructure.timelineBlueprintId,
        totalBars: inlinedStructure.totalBars,
        sections: inlinedStructure.inlinedArrangementMap.map((s) => s.section),
      },
    });

    // 3d. DECOMPRESSION ENLINEMENT — genre LUFS + section dynamics + true-peak ceiling.
    const { DecompressionEnlinement } = await import("@/lib/DecompressionEnlinement");
    const sectionDynamics = DecompressionEnlinement.deriveSectionDynamicsFromInline(
      ctx,
      inlinedStructure,
      { genreMasterLufs: genreEntitlement.appliedRules.masterLufsTarget },
    );
    const decompression = DecompressionEnlinement.executeDecompressionEnlinement(
      ctx,
      sectionDynamics,
    );
    TelemetryAlignment.emit(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: {
        stage: "DECOMPRESSION_ENLINEMENT",
        masteringBlueprintId: decompression.masteringBlueprintId,
        peakLimitingCeilingDb: decompression.peakLimitingCeilingDb,
        profileCount: decompression.appliedDynamicProfiles.length,
        genreMasterLufsTarget: genreEntitlement.appliedRules.masterLufsTarget,
        distortionProfile: genreEntitlement.appliedRules.distortionProfile,
      },
    });

    // 4. PASS CTX INTO END-GATE — delivery owner = CTX.userId only.
    //    On success → Ledger Settlement Gate; on fault → Isolated Ground (catch).
    ContextFactory.assertOwner(ctx, ctx.userId);
    const { PipelineFluxCoating } = await import("@/lib/PipelineFluxCoating");
    const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");
    const delivery = await EndGateDispatcher.deliverToUserVault({
      ...PipelineFluxCoating.coatEndGate({
        jobId: coatedJob.id,
        userId: ctx.userId,
        audioUrl: result.audioUrl,
        prompt: genre || studioPayload.prompt,
        providerName: provider.name,
        title: result.title || studioPayload.title || "Untitled Track",
        style: result.style || genre,
        vaultId: coatedJob.vault_id ?? result.vaultId ?? null,
        instrumentalUrl: result.instrumentalUrl ?? null,
        vocalUrl: result.vocalUrl ?? null,
        rawAudioUrl: result.rawAudioUrl ?? null,
        providerTaskId: result.taskId ?? null,
        spendIdempotencyKey: coatedJob.spend_idempotency_key,
        correlationId,
      }),
      executionContext: ctx,
      generationCost: 1,
      result: {
        ...(result.rawResult ?? {}),
        stems: {
          masterUrl: result.audioUrl,
          instrumentalUrl: result.instrumentalUrl ?? null,
          vocalUrl: result.vocalUrl ?? null,
          rawAudioUrl: result.rawAudioUrl ?? null,
        },
        intuitiveDismantelPlacement: dismantel,
        musicStructureInlining: inlinedStructure,
        decompressionEnlinement: decompression,
        genreEntitlementPlacement: genreEntitlement,
        styleInfluenceEnlightment: styleInfluence,
        bpmEnlinement: bpmTiming,
        logicalRhythmEnlinement: rhythmBlueprint,
        classicalTheoryEngine: theoryBlueprint,
        musicalOntologyAndLogic: philosophyBlueprint,
        recordedVoiceStructureEnlinement: recordedVoiceAlignments,
        styleLyricEnlinement: lyricEnlinement,
        algorithmicVocalBalance: vocalBalance,
        wierdnessEnlinement: wierdness,
        taskId: result.taskId ?? null,
        providerMetadata: result.providerMetadata,
        providerDispatch,
        executionContext: {
          requestId: ctx.requestId,
          sessionNonce: ctx.sessionNonce,
          tier: ctx.tier,
          sourceGate: ctx.sourceGate,
        },
        fluctuation: {
          nonce: modulated.fluctuationNonce,
          tier: coatedModulation.parameters.tier,
          temperature: coatedModulation.parameters.temperature,
          steps: coatedModulation.parameters.steps,
          targetUserUuid: ctx.userId,
        },
        deepIsolationPlacement: {
          targetClusterNode: secured.node,
          isolationLevel: secured.isolationLevel,
          reactorNonce: secured.nonce,
          securityVerdict: secured.securityVerdict,
        },
      },
    });

    const deliveredVaultId = delivery.vaultId;
    const settlement = delivery.settlement;

    const durationMs = Date.now() - startTime;

    await PipelineInformant.recordTelemetry({
      eventType: "GENERATION_SUCCESS",
      jobId: coatedJob.id,
      userId: ctx.userId,
      metadata: {
        requestId: ctx.requestId,
        provider: provider.name,
        durationMs,
        vaultId: deliveredVaultId,
        correlationId,
        hasAudioUrl: true,
        fluctuationNonce: modulated.fluctuationNonce,
        settlementId: settlement.settlementId,
        publisherSyncStatus: settlement.publisherSyncStatus,
        reactor: {
          entanglementLevel: reactorLog.entanglementLevel,
          suppressionActive: reactorLog.suppressionActive,
          aggressiveDampening: reactorLog.aggressiveDampening,
          reactorNonce: reactorLog.reactorNonce,
        },
      },
    });

    // Consequence behavior: stable/slow success → ease or lightly back off throttle.
    const { ConsequenceBehaviorEngine } = await import("@/lib/ConsequenceBehaviorEngine");
    await ConsequenceBehaviorEngine.adaptToConsequences({
      jobId: coatedJob.id,
      userId: ctx.userId,
      success: true,
      executionDurationMs: durationMs,
    });

    console.info("[generation-jobs-worker] completed", {
      jobId: coatedJob.id,
      userId: ctx.userId,
      requestId: ctx.requestId,
      vaultId: deliveredVaultId,
      settlementId: settlement.settlementId,
      publisherSyncStatus: settlement.publisherSyncStatus,
      provider: provider.name,
      durationMs,
      correlationId,
    });
  } catch (error) {
    const message =
      error instanceof ContextRejectionError || error instanceof FluxRejectionError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error ?? "Generation failed");
    const durationMs = Date.now() - startTime;
    console.error("[generation-jobs-worker] job failed", {
      jobId: coatedJob.id,
      userId: ctx.userId,
      requestId: ctx.requestId,
      message: message.slice(0, 400),
      durationMs,
    });

    // Isolated Ground Connector — divert contaminated fault off the hot path.
    let groundDrainReference: string | null = null;
    try {
      const { IsolatedGroundConnector } = await import("@/lib/IsolatedGroundConnector");
      groundDrainReference = await IsolatedGroundConnector.drainFaultToGround(ctx, {
        errorCode:
          error instanceof ContextRejectionError
            ? "CTX_REJECTION"
            : error instanceof FluxRejectionError
              ? "FLUX_REJECTION"
              : "CORE_EXECUTION_FAULT",
        faultSource: IsolatedGroundConnector.classifyFaultSource(error),
        rawContaminatedData:
          error instanceof Error ? error.stack || error.message : String(error ?? "unknown"),
        drainNonce: `drain_${ctx.sessionNonce}`,
      });
    } catch {
      /* never block End-Gate refund */
    }

    await PipelineInformant.recordTelemetry({
      eventType: "GENERATION_FAILURE",
      jobId: coatedJob.id,
      userId: ctx.userId,
      metadata: {
        error: message.slice(0, 500),
        durationMs,
        requestId: ctx.requestId,
        fluxRejected: error instanceof FluxRejectionError,
        ctxRejected: error instanceof ContextRejectionError,
        groundDrainReference,
      },
    });

    // Consequence behavior: failure spike → tighten throttle for next cycles.
    try {
      const { ConsequenceBehaviorEngine } = await import("@/lib/ConsequenceBehaviorEngine");
      await ConsequenceBehaviorEngine.adaptToConsequences({
        jobId: coatedJob.id,
        userId: ctx.userId,
        success: false,
        executionDurationMs: durationMs,
        errorMessage: message,
      });
    } catch {
      /* never block refund path */
    }

    // Safe fallback bound to CTX owner.
    const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");
    await EndGateDispatcher.handleDeliveryFailure({
      jobId: coatedJob.id,
      userId: ctx.userId,
      errorMessage: groundDrainReference
        ? `${message} [ground:${groundDrainReference}]`
        : message,
      spendIdempotencyKey: coatedJob.spend_idempotency_key,
      vaultId: coatedJob.vault_id,
    });

    if (coatedJob.spend_idempotency_key) {
      await PipelineInformant.recordTelemetry({
        eventType: "TOKEN_REFUND",
        jobId: coatedJob.id,
        userId: ctx.userId,
        metadata: {
          reason: "pipeline_failure_exception",
          spendIdempotencyKey: coatedJob.spend_idempotency_key,
          durationMs,
          requestId: ctx.requestId,
          groundDrainReference,
        },
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
