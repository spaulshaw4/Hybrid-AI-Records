import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import {
  DetanglementReactor,
  runReactorSuppressionGate,
} from "@/lib/DetanglementReactor";

describe("DetanglementReactor", () => {
  it("deep-clones and returns reactor state with suppression active", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { requestId: "req-reactor-1", sessionNonce: "nonce_r1" },
    );
    const raw = {
      prompt: "neon rain",
      __sharedGlobalRef: { leak: true },
      nested: { a: 1 },
    };
    const { sanitizedPayload, reactorState } = DetanglementReactor.purgeCrossCorrelations(
      ctx,
      raw,
    );

    expect(sanitizedPayload).not.toBe(raw);
    expect(sanitizedPayload.nested).not.toBe(raw.nested);
    expect(sanitizedPayload.__sharedGlobalRef).toBeUndefined();
    expect(reactorState.suppressionActive).toBe(true);
    expect(reactorState.reactorNonce).toBe("reactor_nonce_r1");
    expect(reactorState.entanglementLevel).toBeGreaterThanOrEqual(0);
    expect(reactorState.entanglementLevel).toBeLessThanOrEqual(0.1);
  });

  it("runReactorSuppressionGate marks DETANGLED_AND_SECURE", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "n2", requestId: "r2" },
    );
    const gate = runReactorSuppressionGate(ctx, {
      prompt: "ambient",
      __unsecuredVector: [1, 2, 3],
    });
    expect(gate.status).toBe("DETANGLED_AND_SECURE");
    expect(gate.payload.__unsecuredVector).toBeUndefined();
    expect(gate.reactorLog.reactorNonce).toContain("reactor_");
  });

  it("feeds DeepIsolationPlacement immediately before Fluctuator in the worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const isoIdx = source.indexOf("dispatchToSecureCore");
    const fluctIdx = source.indexOf("CtxFluctuatorEngine.modulate");
    expect(isoIdx).toBeGreaterThan(-1);
    expect(fluctIdx).toBeGreaterThan(isoIdx);
    expect(source).toContain("detanglementReactor");
  });
});
