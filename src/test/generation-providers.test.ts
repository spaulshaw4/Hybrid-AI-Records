import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("GenerationFactory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("defaults to hybrid-engine", async () => {
    const { GenerationFactory } = await import("@/lib/generation-providers/GenerationFactory");
    const provider = GenerationFactory.getProvider();
    expect(provider.name).toBe("hybrid-engine");
  });

  it("resolves third-party-wrapper from env", async () => {
    vi.stubEnv("ACTIVE_GENERATION_PROVIDER", "third-party-wrapper");
    const { GenerationFactory } = await import("@/lib/generation-providers/GenerationFactory");
    const provider = GenerationFactory.getProvider();
    expect(provider.name).toBe("third-party-wrapper");
  });

  it("throws on unknown provider", async () => {
    const { GenerationFactory } = await import("@/lib/generation-providers/GenerationFactory");
    expect(() => GenerationFactory.getProvider("not-a-real-provider")).toThrow(
      /Unknown generation provider/,
    );
  });

  it("lists known providers", async () => {
    const { GenerationFactory } = await import("@/lib/generation-providers/GenerationFactory");
    expect(GenerationFactory.listProviders()).toEqual([
      "hybrid-engine",
      "third-party-wrapper",
    ]);
  });
});

describe("provider abstraction wiring", () => {
  it("worker uses GenerationFactory instead of hardcoding runGenerateEngineTrack", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("GenerationFactory.getProvider");
    expect(source).toContain("provider.generateTrack");
    expect(source).toContain("EndGateDispatcher.deliverToUserVault");
    expect(source).not.toContain("runGenerateEngineTrack(payload");
  });

  it("exports the abstract contract", async () => {
    const mod = await import("@/lib/generation-providers");
    expect(mod.AudioGenerationProvider).toBeTypeOf("function");
    expect(mod.GenerationFactory).toBeTypeOf("function");
    expect(mod.ThirdPartyApiProvider).toBeTypeOf("function");
    expect(mod.HybridEngineProvider).toBeTypeOf("function");
  });
});
