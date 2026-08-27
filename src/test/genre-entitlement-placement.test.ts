import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { GenreEntitlementPlacement } from "@/lib/GenreEntitlementPlacement";
import { IntuitiveDismantelPlacement } from "@/lib/IntuitiveDismantelPlacement";

describe("GenreEntitlementPlacement", () => {
  it("passes when BPM is inside the genre range", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_ent", requestId: "req_ent_1" },
    );
    const result = GenreEntitlementPlacement.verifyAndEnforceEntitlement(
      ctx,
      "AMAPIANO",
      112,
    );
    expect(result.entitlementStatus).toBe("PASSED_ENTITLEMENT");
    expect(result.appliedRules.subBassRouting).toBe("MONO_LOCKED");
    expect(result.appliedRules.distortionProfile).toBe("CLEAN");
    expect(result.appliedRules.masterLufsTarget).toBe(-11.5);
  });

  it("quarantines BPM outside genre entitlement", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_q" },
    );
    const result = GenreEntitlementPlacement.verifyAndEnforceEntitlement(
      ctx,
      "NU_METAL",
      160,
    );
    expect(result.entitlementStatus).toBe("GENRE_MISMATCH_QUARANTINED");
    expect(result.appliedRules.requiredBpmRange).toEqual([95, 130]);
  });

  it("resolves free-text genres and mid-range BPM defaults", () => {
    expect(GenreEntitlementPlacement.resolveSupportedGenre("Amapiano log drums")).toBe(
      "AMAPIANO",
    );
    expect(GenreEntitlementPlacement.resolveSupportedGenre("nu-metal riff")).toBe("NU_METAL");
    expect(GenreEntitlementPlacement.resolveSupportedGenre("rap rock fusion")).toBe("RAP_ROCK");
    const bpm = GenreEntitlementPlacement.resolveBpm(undefined, "RAP_ROCK");
    expect(bpm).toBeGreaterThanOrEqual(85);
    expect(bpm).toBeLessThanOrEqual(120);
  });

  it("feeds sub-bass routing into dismantel placement", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "aligned-runner",
      { sessionNonce: "nonce_sub", requestId: "req_sub" },
    );
    const stems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
      ctx,
      hasMaster: true,
      hasInstrumental: true,
    });
    let dismantel = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, stems);
    dismantel = IntuitiveDismantelPlacement.applyGenreSubBassRouting(
      dismantel,
      "SIDECHAIN_COMPRESSED",
    );
    const bass = dismantel.reallocatedStems.find((s) => s.stemName === "bass");
    expect(bass?.assignedSpatialBus).toBe("sidechain-sub-bus");
    expect(bass?.dismantelAction).toBe("DOWNMIXED");
  });

  it("is wired before dismantel in the worker music chain", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const entIdx = source.indexOf("GenreEntitlementPlacement.verifyAndEnforceEntitlement");
    const disIdx = source.indexOf("IntuitiveDismantelPlacement.executeDismantelPlacement");
    const decompIdx = source.indexOf("genreMasterLufs");
    expect(entIdx).toBeGreaterThan(-1);
    expect(disIdx).toBeGreaterThan(entIdx);
    expect(decompIdx).toBeGreaterThan(disIdx);
    expect(source).toContain("genreEntitlementPlacement");
    expect(source).toContain("GENRE_MISMATCH_QUARANTINED");
  });
});
