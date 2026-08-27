import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("generation_queue / generation_jobs migration", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20260827140000_generation_queue.sql"),
    "utf8",
  );

  it("creates generation_queue with required columns and statuses", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.generation_queue/);
    expect(sql).toMatch(/user_id uuid NOT NULL/);
    expect(sql).toMatch(/prompt_payload jsonb/);
    expect(sql).toMatch(/pending.*processing.*completed.*failed/s);
    expect(sql).toMatch(/created_at timestamptz/);
  });

  it("claims jobs with FOR UPDATE SKIP LOCKED", () => {
    expect(sql).toMatch(/claim_generation_queue_job/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.claim_generation_queue_job/);
  });

  it("scopes RLS to auth.uid() = user_id", () => {
    expect(sql).toMatch(/auth\.uid\(\) = user_id/);
  });

  it("exposes generation_jobs view alias", () => {
    const view = readFileSync(
      join(process.cwd(), "supabase/migrations/20260827143000_generation_jobs_view.sql"),
      "utf8",
    );
    expect(view).toMatch(/CREATE OR REPLACE VIEW public\.generation_jobs/);
    expect(view).toMatch(/FROM public\.generation_queue/);
  });
});

describe("async cloud-native generation contracts", () => {
  it("cortex burns tokens before queue insert and refunds on Gate 2 failure", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/cortex-dispatcher.server.ts"),
      "utf8",
    );
    const burnIdx = source.indexOf("authorizeAndSpendGenerationToken");
    const insertIdx = source.indexOf('.from("generation_queue")');
    expect(burnIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(burnIdx);
    expect(source).toContain("refundGenerationToken");
    expect(source).toContain("persistUserVault(admin, userId");
    expect(source).toContain("Generation queued successfully");
  });

  it("worker settles vault to job.user_id and refunds on failure", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("claim_generation_queue_job");
    expect(source).toContain("GenerationFactory.getProvider");
    expect(source).toContain("provider.generateTrack");
    expect(source).toContain("EndGateDispatcher.deliverToUserVault");
    expect(source).toContain("EndGateDispatcher.handleDeliveryFailure");
    expect(source).toContain("runGenerationJobsWorkerForever");
    expect(source).toContain("GENERATION_QUEUE_THROTTLE_MS");
  });

  it("ingress routes return 202 via cortex (no inline shared-key processing)", () => {
    const queue = readFileSync(
      join(process.cwd(), "src/routes/api/studio/generate-queue.ts"),
      "utf8",
    );
    const stream = readFileSync(
      join(process.cwd(), "src/routes/api/studio/generate-stream.ts"),
      "utf8",
    );
    expect(queue).toContain("executeGenerationCortex");
    expect(queue).toContain("status: 202");
    expect(queue).not.toContain("runGenerateEngineTrack");
    expect(stream).toContain("executeGenerationCortex");
    expect(stream).toContain("status: 202");
    expect(stream).not.toContain("runGenerateEngineTrack");
    expect(stream).not.toContain("createGenerateSseResponse");
  });

  it("browser client defaults to queue poll (not inline SSE processing)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/studio-generate-fetch.ts"),
      "utf8",
    );
    expect(source).toContain("STUDIO_GENERATE_QUEUE_URL");
    expect(source).toContain("runQueuedStudioGenerate");
    expect(source).toContain("VITE_GENERATE_INLINE_SSE");
  });

  it("ships an isolated worker script", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/generation-jobs-worker.ts"),
      "utf8",
    );
    expect(source).toContain("runGenerationJobsWorkerForever");
  });
});

describe("executeGenerationCortex unit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds vault + queue rows to the requesting userId", async () => {
    const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const vaultId = "11111111-1111-4111-8111-111111111111";
    const queueId = "22222222-2222-4222-8222-222222222222";
    const persistCalls: Array<{ userId: string }> = [];

    vi.doMock("@/integrations/supabase/client.server", () => ({
      tryGetSupabaseAdmin: () => ({
        from: (table: string) => {
          if (table !== "generation_queue") {
            throw new Error(`unexpected table ${table}`);
          }
          return {
            insert: (row: { user_id: string; vault_id: string | null }) => {
              expect(row.user_id).toBe(userId);
              expect(row.vault_id).toBe(vaultId);
              return {
                select: () => ({
                  maybeSingle: async () => ({
                    data: { id: queueId, status: "pending" },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      }),
    }));

    vi.doMock("@/lib/pipeline-idempotency.server", () => ({
      buildGenerationIdempotencyKey: () => "run-test-1",
    }));

    vi.doMock("@/lib/generation-tokens.server", () => ({
      authorizeAndSpendGenerationToken: async (input: { userId: string }) => {
        expect(input.userId).toBe(userId);
        return {
          bypassed: false,
          balance: 9,
          alreadyApplied: false,
          idempotencyKey: "gen:run-test-1",
        };
      },
      generationTokenIdempotencyKey: (k: string) => `gen:${k}`,
      refundGenerationToken: vi.fn(),
      InsufficientTokensError: class InsufficientTokensError extends Error {
        statusCode = 402;
        balance = 0;
      },
    }));

    vi.doMock("@/lib/user-vault.server", () => ({
      persistUserVault: async (_db: unknown, ownerId: string) => {
        persistCalls.push({ userId: ownerId });
        return vaultId;
      },
    }));

    vi.doMock("@/lib/generation-queue-worker.server", () => ({
      kickGenerationQueueWorker: () => undefined,
    }));

    vi.doMock("@/lib/rate-limit", () => ({
      RATE_LIMITS: { generation: { limit: 100, windowMs: 60_000 } },
      limitBy: () => undefined,
    }));

    const { executeGenerationCortex } = await import("@/lib/cortex-dispatcher.server");
    const result = await executeGenerationCortex({
      userId,
      supabase: {} as never,
      promptPayload: {
        prompt: "dark synthwave anthem",
        title: "Test Track",
        lyrics: "hello world lyrics here",
        instrumental: false,
        termsAccepted: true,
        language: "English",
      },
    });

    expect(result.success).toBe(true);
    expect(result.queueId).toBe(queueId);
    expect(result.vaultId).toBe(vaultId);
    expect(result.userId).toBe(userId);
    expect(result.message).toBe("Generation queued successfully");
    expect(result.correlationId).toMatch(/^cortex_/);
    expect(persistCalls).toEqual([{ userId }]);
  });
});
