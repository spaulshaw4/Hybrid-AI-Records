import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import {
  BinaryEntanglementSuppressor,
  executeIsolatedWorkerTask,
} from "@/lib/BinaryEntanglementSuppressor";

describe("BinaryEntanglementSuppressor", () => {
  it("deep-clones payload and stamps immutable CTX boundaries", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_iso_1", requestId: "req-iso-1" },
    );
    const raw = { nested: { value: 1 }, prompt: "test" };
    const clean = BinaryEntanglementSuppressor.suppressCrossTalk(ctx, raw);

    expect(clean).not.toBe(raw);
    expect(clean.nested).not.toBe(raw.nested);
    expect(clean.__isolatedSessionNonce).toBe("nonce_iso_1");
    expect(clean.__entanglementState).toBe("SUPPRESSED_ORTHOGONAL");
    expect(clean.__isolatedRequestId).toBe("req-iso-1");

    raw.nested.value = 99;
    expect(clean.nested.value).toBe(1);

    expect(() => {
      (clean as { __isolatedSessionNonce: string }).__isolatedSessionNonce = "mutated";
    }).toThrow();
  });

  it("verifyDecoupling requires distinct references / nonces", () => {
    const ctxA = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "a", requestId: "1" },
    );
    const ctxB = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "b", requestId: "2" },
    );
    const a = BinaryEntanglementSuppressor.suppressCrossTalk(ctxA, { x: 1 });
    const b = BinaryEntanglementSuppressor.suppressCrossTalk(ctxB, { x: 1 });
    expect(BinaryEntanglementSuppressor.verifyDecoupling(a, b)).toBe(true);
    expect(BinaryEntanglementSuppressor.verifyDecoupling(a, a)).toBe(false);
  });

  it("executeIsolatedWorkerTask returns isolation stamp", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { sessionNonce: "worker_n", requestId: "worker_r" },
    );
    const result = executeIsolatedWorkerTask(ctx, { jobId: "j1", prompt_payload: { p: true } });
    expect(result.status).toBe("EXECUTED_IN_ISOLATION");
    expect(result.nonce).toBe("worker_n");
    expect(result.processedData.__entanglementState).toBe("SUPPRESSED_ORTHOGONAL");
  });

  it("is wired at the queue → worker boundary", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("executeIsolatedWorkerTask");
    expect(source).toContain("BinaryEntanglementSuppressor");
    expect(source).toContain("verifyDecoupling");
  });
});
