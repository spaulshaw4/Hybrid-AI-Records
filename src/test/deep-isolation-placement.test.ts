import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import {
  DeepIsolationPlacement,
  dispatchToSecureCore,
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
        entanglementLevel: 0.09,
        suppressionActive: true,
        reactorNonce: "reactor_nonce_iso_q",
        entropyScore: 0.9,
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
        entanglementLevel: 0.09,
        suppressionActive: true,
        reactorNonce: "reactor_bad",
        entropyScore: 0.9,
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
