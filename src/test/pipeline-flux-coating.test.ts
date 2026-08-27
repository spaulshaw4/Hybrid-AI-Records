import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PipelineFluxCoating,
  FluxRejectionError,
  InGateLiteSchema,
  FluctuatedPayloadSchema,
  EndGateDeliverySchema,
} from "@/lib/PipelineFluxCoating";

describe("PipelineFluxCoating", () => {
  it("coats a valid In-Gate studio payload", () => {
    const coated = PipelineFluxCoating.coatInGate({
      prompt: "neon rain over chrome streets",
      title: "Chrome Rain",
      instrumental: true,
    });
    expect(coated.prompt).toContain("neon rain");
    expect(coated.instrumental).toBe(true);
  });

  it("rejects contaminated In-Gate prompts", () => {
    expect(() => PipelineFluxCoating.coatInGate({ prompt: "x" })).toThrow(FluxRejectionError);
  });

  it("validates InGateLiteSchema (prompt + genreHint)", () => {
    const ok = InGateLiteSchema.safeParse({
      prompt: "acid jazz nocturne",
      genreHint: "jazz",
    });
    expect(ok.success).toBe(true);
    const bad = InGateLiteSchema.safeParse({ prompt: "ab" });
    expect(bad.success).toBe(false);
  });

  it("coats Fluctuator envelopes and rejects bad UUIDs", () => {
    const good = PipelineFluxCoating.coatFluctuated({
      prompt: "modulated",
      fluctuationNonce: "nonce_1",
      parameters: {
        temperature: 0.7,
        steps: 100,
        targetUserUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        isolatedEnvironment: true,
        tier: "consumer",
        executionEngine: "algorithmic-deterministic",
        styleWeight: 0.75,
      },
      profileSnapshot: { preferences: {}, tokenBalance: null },
    });
    expect(good.parameters.steps).toBe(100);

    expect(() =>
      PipelineFluxCoating.coatAndVerify(FluctuatedPayloadSchema, {
        prompt: "x",
        fluctuationNonce: "n",
        parameters: {
          temperature: 0.7,
          steps: 100,
          targetUserUuid: "not-a-uuid",
          isolatedEnvironment: true,
          tier: "consumer",
        },
      }),
    ).toThrow(/Flux Rejection/);
  });

  it("coats End-Gate delivery and rejects slag URLs", () => {
    const good = PipelineFluxCoating.coatEndGate({
      jobId: "22222222-2222-4222-8222-222222222222",
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      audioUrl: "https://cdn.example.com/track.mp3",
      prompt: "neon rain",
      providerName: "hybrid-engine",
    });
    expect(good.audioUrl).toMatch(/^https:/);

    expect(() =>
      PipelineFluxCoating.coatAndVerify(EndGateDeliverySchema, {
        jobId: "22222222-2222-4222-8222-222222222222",
        userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        audioUrl: "javascript:alert(1)",
        prompt: "x",
        providerName: "hybrid-engine",
      }),
    ).toThrow(FluxRejectionError);
  });

  it("is wired into cortex, fluctuator, worker, and end-gate", () => {
    const cortex = readFileSync(
      join(process.cwd(), "src/lib/cortex-dispatcher.server.ts"),
      "utf8",
    );
    const fluctuator = readFileSync(join(process.cwd(), "src/lib/FluctuatorEngine.ts"), "utf8");
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const endGate = readFileSync(join(process.cwd(), "src/lib/EndGateDispatcher.ts"), "utf8");

    expect(cortex).toContain("PipelineFluxCoating.coatInGate");
    expect(fluctuator).toContain("PipelineFluxCoating.coatFluctuated");
    expect(worker).toContain("PipelineFluxCoating.coatQueueJob");
    expect(worker).toContain("PipelineFluxCoating.coatEndGate");
    expect(endGate).toContain("PipelineFluxCoating.coatEndGate");
  });
});
