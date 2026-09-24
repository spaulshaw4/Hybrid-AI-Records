import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import {
  DeepIsolationPlacement,
  dispatchToSecureCore,
  sanitizeCompositionInput,
} from "@/lib/DeepIsolationPlacement";

describe("DeepIsolationPlacement", () => {
  beforeEach(() => {
    process.env.MAX_NODE_CAPACITY = "25";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MAX_NODE_CAPACITY;
  });

  it("routes enterprise to isolated grid when reactor is clean", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { sessionNonce: "nonce_iso_ent", requestId: "req-iso-1" },
    );

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "clean enterprise track", genre: "ambient" },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_nonce_iso_ent",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const envelope = await DeepIsolationPlacement.routeAndPlace(ctx, {
      prompt: "clean enterprise track",
    });

    expect(envelope.securityVerdict).toBe("PASSED_ISOLATION");
    expect(envelope.targetClusterNode).toBe("enterprise-isolated-grid-01");
    expect(envelope.isolationLevel).toBe("ORTHOGONAL_SUPPRESSED");
    expect(envelope.sanitizedPayload.prompt).toBe("clean enterprise track");
    expect(envelope.reactorNonce).toBe("reactor_nonce_iso_ent");
  });

  it("routes free/pro to standard worker grid", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
    );

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "pro track" },
      reactorState: {
        entanglementLevel: 0.01,
        suppressionActive: true,
        reactorNonce: "reactor_std",
        entropyScore: 0.1,
        aggressiveDampening: false,
      },
    });

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const envelope = await DeepIsolationPlacement.routeAndPlace(ctx, { prompt: "pro track" });
    expect(envelope.targetClusterNode).toBe("standard-worker-grid-pool");
    expect(envelope.securityVerdict).toBe("PASSED_ISOLATION");
  });

  it("falls back to standby overflow when primary node is saturated", async () => {
    process.env.MAX_NODE_CAPACITY = "2";
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_sat", requestId: "req-sat" },
    );

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "busy" },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_sat",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: (table: string) => {
        if (table === "generation_queue") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ count: 5, error: null }),
              }),
            }),
          };
        }
        return {
          insert: async () => ({ error: null }),
        };
      },
    } as never);

    const envelope = await DeepIsolationPlacement.routeAndPlace(ctx, { prompt: "busy" });
    expect(envelope.securityVerdict).toBe("FALLBACK_ROUTED");
    expect(envelope.targetClusterNode).toBe("standby-overflow-grid-pool");
    expect(envelope.isolationLevel).toBe("ORTHOGONAL_SUPPRESSED_FALLBACK");
  });

  it("quarantines when entanglement exceeds ceiling", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_iso_q", requestId: "req-iso-q" },
    );

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "leaky", __sharedGlobalRef: true },
      reactorState: {
        entanglementLevel: 0.12,
        suppressionActive: true,
        reactorNonce: "reactor_nonce_iso_q",
        entropyScore: 0.95,
        aggressiveDampening: true,
      },
    });

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const envelope = await DeepIsolationPlacement.routeAndPlace(ctx, { prompt: "leaky" });

    expect(envelope.securityVerdict).toBe("QUARANTINED");
    expect(envelope.targetClusterNode).toBe("quarantine-isolation-node");
    expect(envelope.isolationLevel).toBe("MAXIMUM_SECURITY_STRIPPED");
    expect(envelope.sanitizedPayload.error).toMatch(/failed deep isolation/i);
  });

  it("strips queue-row metadata before the reactor and keeps composition fields", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_san", requestId: "req-san" },
    );

    const reactorSpy = vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: {
        prompt: "clean studio track",
        genre: "house",
        bpm: 124,
        keySignature: "Am",
        bars: 32,
      },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_nonce_san",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const envelope = await DeepIsolationPlacement.routeAndPlace(ctx, {
      prompt: "clean studio track",
      genre: "house",
      spend_idempotency_key: "spend_abc",
      vault_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      retry_count: 3,
      created_at: "2026-01-01T00:00:00Z",
      __isolatedSessionNonce: "leaked_nonce",
      jobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });

    expect(reactorSpy).toHaveBeenCalled();
    const reactorInput = reactorSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reactorInput.prompt).toBe("clean studio track");
    expect(reactorInput.genre).toBe("house");
    expect(reactorInput.spend_idempotency_key).toBeUndefined();
    expect(reactorInput.vault_id).toBeUndefined();
    expect(reactorInput.retry_count).toBeUndefined();
    expect(reactorInput.created_at).toBeUndefined();
    expect(reactorInput.__isolatedSessionNonce).toBeUndefined();
    expect(reactorInput.jobId).toBeUndefined();
    expect(envelope.securityVerdict).toBe("PASSED_ISOLATION");
    expect(envelope.reactorNonce).toBe("reactor_nonce_san");
  });

  it("sanitizeCompositionInput allowlists musical fields only", () => {
    const cleaned = sanitizeCompositionInput({
      prompt: "neon bass",
      genre_hint: "techno",
      bpm: "128",
      spend_idempotency_key: "x",
      vault_id: "y",
      __entanglementState: "SUPPRESSED_ORTHOGONAL",
    });
    expect(cleaned.prompt).toBe("neon bass");
    expect(cleaned.genre).toBe("techno");
    expect(cleaned.bpm).toBe(128);
    // Techno maps to the dark minor pool (E / D / F# minor), not a flat "C".
    expect(["E minor", "D minor", "F# minor"]).toContain(cleaned.keySignature);
    // 210 s default at 128 BPM -> round(210 * 128 / 240) = 112 bars
    expect(cleaned.bars).toBe(112);
    expect(sanitizeCompositionInput({ prompt: "x", bpm: 110, durationSeconds: 210 }).bars).toBe(96);
    expect(
      sanitizeCompositionInput({ prompt: "upbeat summer hit", genre: "pop" }).keySignature,
    ).toMatch(/major$/i);
    expect(
      sanitizeCompositionInput({
        prompt: "moody",
        genre: "pop",
        keySignature: "E minor",
      }).keySignature,
    ).toBe("E minor");
    expect(cleaned.spend_idempotency_key).toBeUndefined();
    expect(cleaned.vault_id).toBeUndefined();
    expect(cleaned.__entanglementState).toBeUndefined();
  });

  it("dispatchToSecureCore returns node/payload/nonce or SECURITY HALT", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_disp" },
    );

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "ok" },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_ok",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const secured = await dispatchToSecureCore(ctx, { prompt: "ok" });
    expect(secured.node).toBe("standard-worker-grid-pool");
    expect(secured.payload.prompt).toBe("ok");
    expect(secured.nonce).toBe("reactor_ok");

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: {},
      reactorState: {
        entanglementLevel: 0.12,
        suppressionActive: true,
        reactorNonce: "reactor_bad",
        entropyScore: 0.95,
        aggressiveDampening: true,
      },
    });

    await expect(dispatchToSecureCore(ctx, { prompt: "bad" })).rejects.toThrow(
      /\[SECURITY HALT\]/,
    );
  });

  it("is wired via dispatchToSecureCore before Fluctuator", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const isoIdx = source.indexOf("dispatchToSecureCore");
    const fluctIdx = source.indexOf("CtxFluctuatorEngine.modulate");
    expect(isoIdx).toBeGreaterThan(-1);
    expect(fluctIdx).toBeGreaterThan(isoIdx);
    expect(source).toContain("assigned_node");
    expect(source).toContain("deepIsolationPlacement");
  });
});
