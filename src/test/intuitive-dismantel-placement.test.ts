import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { IntuitiveDismantelPlacement } from "@/lib/IntuitiveDismantelPlacement";

describe("IntuitiveDismantelPlacement", () => {
  it("isolates bass/sub and widens harmony/presence", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_dismantel", requestId: "req_dismantel_1" },
    );

    const result = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, [
      { stemName: "bass", energyIndex: 0.6, frequencyTier: "sub" },
      { stemName: "harmony", energyIndex: 0.5, frequencyTier: "presence" },
      { stemName: "drums", energyIndex: 0.92, frequencyTier: "low-mid" },
      { stemName: "lead", energyIndex: 0.4, frequencyTier: "air" },
    ]);

    expect(result.restructuredArrangementId).toMatch(/^dismantel_nonce_dismantel_/);
    expect(result.harmonicBalanceScore).toBeGreaterThanOrEqual(0.85);
    expect(result.harmonicBalanceScore).toBeLessThanOrEqual(1);

    const byName = Object.fromEntries(
      result.reallocatedStems.map((s) => [s.stemName, s]),
    );
    expect(byName.bass.dismantelAction).toBe("ISOLATED");
    expect(byName.bass.assignedSpatialBus).toBe("sub-low-isolated-bus");
    expect(byName.harmony.dismantelAction).toBe("WIDENED");
    expect(byName.drums.dismantelAction).toBe("DOWNMIXED");
  });

  it("is deterministic for the same CTX + stems", () => {
    const mk = () =>
      ContextFactory.create(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "enterprise",
        "aligned-runner",
        { sessionNonce: "nonce_det", requestId: "req_det_fixed" },
      );
    const stems = [
      { stemName: "bass" as const, energyIndex: 0.5, frequencyTier: "sub" as const },
      { stemName: "harmony" as const, energyIndex: 0.6, frequencyTier: "presence" as const },
    ];
    const a = IntuitiveDismantelPlacement.executeDismantelPlacement(mk(), stems);
    const b = IntuitiveDismantelPlacement.executeDismantelPlacement(mk(), stems);
    expect(a.harmonicBalanceScore).toBe(b.harmonicBalanceScore);
  });

  it("derives stems from generation artifacts", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { requestId: "req_derive", sessionNonce: "nonce_derive" },
    );
    const stems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
      ctx,
      hasMaster: true,
      hasInstrumental: true,
      hasVocal: true,
      hasRaw: false,
    });
    expect(stems.some((s) => s.stemName === "bass")).toBe(true);
    expect(stems.some((s) => s.stemName === "lead")).toBe(true);
  });

  it("is wired after provider and before End-Gate in the worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const genIdx = source.indexOf("provider.generateTrack");
    const disIdx = source.indexOf("IntuitiveDismantelPlacement.executeDismantelPlacement");
    const endIdx = source.indexOf("EndGateDispatcher.deliverToUserVault");
    expect(genIdx).toBeGreaterThan(-1);
    expect(disIdx).toBeGreaterThan(genIdx);
    expect(endIdx).toBeGreaterThan(disIdx);
    expect(source).toContain("intuitiveDismantelPlacement");
  });
});
