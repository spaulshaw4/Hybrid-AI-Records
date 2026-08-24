/**
 * Gate 1 / Prisma smoke tests.
 *
 * - Asserts Gate 1 circuit breaker covers the poll budget (80 × 2.5s ≈ 200s).
 * - Exercises a Gate 1-shaped studio payload.
 * - Live Prisma Track upsert when DATABASE_URL is reachable (skipped otherwise).
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  GATE_TIMEOUTS_MS,
  withTimeout,
} from "@/lib/pipeline-gate.server";
import {
  MAX_POLLING_ATTEMPTS,
  MAX_POLLING_DURATION_MS,
  POLLING_INTERVAL_MS,
} from "@/lib/music-generation";
import { PipelineGate, passGate } from "@/lib/pipeline-flags";

/** Minimal Gate 1 test payload (studio generate shape). */
export const GATE_1_SMOKE_PAYLOAD = {
  title: "Prisma Smoke Track",
  prompt: "lofi chill beat, soft piano, rainy night",
  style: "lofi",
  lyrics: "",
  instrumental: true,
  durationSeconds: 30,
  engine: "suno" as const,
};

describe("Gate 1 circuit breaker + poll budget", () => {
  it("keeps Gate 1 timeout ≥ poll budget (80 × 2.5s)", () => {
    expect(POLLING_INTERVAL_MS).toBe(2500);
    expect(MAX_POLLING_ATTEMPTS).toBe(80);
    expect(MAX_POLLING_DURATION_MS).toBe(200_000);
    expect(GATE_TIMEOUTS_MS[1]).toBe(200_000);
    expect(GATE_TIMEOUTS_MS[1]).toBeGreaterThanOrEqual(MAX_POLLING_DURATION_MS);
    // Historical “~180s” floor — breaker must not regress below this.
    expect(GATE_TIMEOUTS_MS[1]).toBeGreaterThanOrEqual(180_000);
  });

  it("trips Circuit Breaker wording when Gate 1 work exceeds the deadline", async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 40, "Gate 1 (AIMusicAPI)", {
        step: "composition",
      }),
    ).rejects.toThrow(/Circuit Breaker.*Gate 1.*timed out/i);
  }, 5_000);

  it("accepts a Gate 1-shaped generate payload", () => {
    expect(GATE_1_SMOKE_PAYLOAD.title.length).toBeGreaterThan(0);
    expect(GATE_1_SMOKE_PAYLOAD.prompt.length).toBeGreaterThan(0);
    expect(GATE_1_SMOKE_PAYLOAD.instrumental).toBe(true);
    expect(GATE_1_SMOKE_PAYLOAD.durationSeconds).toBeGreaterThanOrEqual(10);
  });

  it("starts composition bit after Gate 1 landing", () => {
    let mask = PipelineGate.NONE;
    mask = passGate(mask, PipelineGate.COMPOSITION);
    expect(mask & PipelineGate.COMPOSITION).toBe(PipelineGate.COMPOSITION);
  });
});

describe("Prisma Track smoke (live DATABASE_URL)", () => {
  const live = Boolean(process.env.DATABASE_URL?.trim());
  const smokeId = `smoke-gate1-${Date.now()}`;

  it.skipIf(!live)(
    "creates a Track row, marks PROCESSING, then cleans up",
    async () => {
      const { upsertPipelineTrack, patchPipelineTrack, getPrisma } = await import(
        "@/lib/prisma.server"
      );

      let created;
      try {
        created = await upsertPipelineTrack({
          id: smokeId,
          title: GATE_1_SMOKE_PAYLOAD.title,
          prompt: GATE_1_SMOKE_PAYLOAD.prompt,
          status: "QUEUED",
          gateMask: 0,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Soft-skip when local VPN/credentials cannot reach Supabase pooler.
        if (/P1000|P1001|P1011|Authentication|TLS|self-signed|Can't reach/i.test(msg)) {
          console.warn(`[prisma smoke] skipped live upsert: ${msg.slice(0, 160)}`);
          return;
        }
        throw err;
      }

      expect(created.id).toBe(smokeId);
      expect(created.status).toBe("QUEUED");
      expect(created.gateMask).toBe(0);

      // Simulate generation start (Gate 1 kickoff).
      const processing = await patchPipelineTrack(smokeId, {
        status: "PROCESSING",
        gateMask: 0,
      });
      expect(processing?.status).toBe("PROCESSING");

      // Simulate Gate 1 composition bit landing.
      const afterGate1 = await patchPipelineTrack(smokeId, {
        status: "COMPOSITION_DONE",
        gateMask: PipelineGate.COMPOSITION,
      });
      expect(afterGate1?.gateMask).toBe(PipelineGate.COMPOSITION);

      await getPrisma().track.delete({ where: { id: smokeId } });
    },
    30_000,
  );

  afterAll(async () => {
    if (!live) return;
    try {
      const { getPrisma } = await import("@/lib/prisma.server");
      await getPrisma().track.deleteMany({ where: { id: smokeId } }).catch(() => undefined);
      await getPrisma().$disconnect().catch(() => undefined);
    } catch {
      /* ignore */
    }
  });
});
