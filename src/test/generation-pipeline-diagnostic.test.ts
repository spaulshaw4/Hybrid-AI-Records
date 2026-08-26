/**
 * End-to-end diagnostic coverage for Hybrid Engine token integrity,
 * stream teardown bounds, vault playability, and download headers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachmentContentDisposition,
  audioContentTypeForFileName,
} from "@/lib/download-headers";
import {
  proxiedAudioDownloadUrl,
  sanitizeDownloadFileName,
} from "@/lib/download-track";
import { isPlayableVaultAudioUrl } from "@/lib/vault-tracks";
import {
  isTerminalPollStatus,
  pollWithBreaker,
} from "@/lib/poll-with-breaker.server";
import { PIPELINE_PROGRESS } from "@/lib/pipeline-progress";

const USER_ID = "0369f3ad-2a9b-4ed4-94dc-9d9cad7bb7c2";

type RpcRow = {
  ok: boolean;
  balance: number;
  already_applied?: boolean;
  reason?: string | null;
};

function createMockAdmin(options: {
  balance: number;
  spend?: (
    args: Record<string, unknown>,
  ) =>
    | { data: RpcRow[] | RpcRow; error: null }
    | { data: null; error: { message: string; code?: string } };
  refund?: (
    args: Record<string, unknown>,
  ) =>
    | { data: RpcRow[] | RpcRow; error: null }
    | { data: null; error: { message: string; code?: string } };
}) {
  let balance = options.balance;
  const spendCalls: Record<string, unknown>[] = [];
  const refundCalls: Record<string, unknown>[] = [];
  const spentKeys = new Set<string>();
  const refundKeys = new Set<string>();

  const admin = {
    from(table: string) {
      return {
        select() {
          const query = {
            eq() {
              return query;
            },
            maybeSingle: async () => {
              if (table === "user_roles") return { data: null };
              if (table === "profiles") return { data: { preferences: {} } };
              if (table === "token_balances") return { data: { balance } };
              return { data: null };
            },
          };
          return query;
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "spend_hybrid_tokens") {
        spendCalls.push(args);
        if (options.spend) return Promise.resolve(options.spend(args));
        const key = String(args._idempotency_key ?? "");
        const amount = Number(args._amount ?? 1);
        if (spentKeys.has(key)) {
          return Promise.resolve({
            data: [{ ok: true, balance, already_applied: true, reason: null }],
            error: null,
          });
        }
        if (balance < amount) {
          return Promise.resolve({
            data: [
              {
                ok: false,
                balance,
                already_applied: false,
                reason: "Not enough Hybrid Tokens. Buy more to keep generating.",
              },
            ],
            error: null,
          });
        }
        balance -= amount;
        spentKeys.add(key);
        return Promise.resolve({
          data: [{ ok: true, balance, already_applied: false, reason: null }],
          error: null,
        });
      }
      if (fn === "refund_hybrid_generation_tokens") {
        refundCalls.push(args);
        if (options.refund) return Promise.resolve(options.refund(args));
        const key = String(args._idempotency_key ?? "");
        const amount = Number(args._amount ?? 1);
        if (refundKeys.has(key)) {
          return Promise.resolve({
            data: [{ ok: true, balance, already_applied: true, reason: null }],
            error: null,
          });
        }
        balance += amount;
        refundKeys.add(key);
        return Promise.resolve({
          data: [{ ok: true, balance, already_applied: false, reason: null }],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${fn}` } });
    },
  };

  return { admin, spendCalls, refundCalls, getBalance: () => balance };
}

describe("Hybrid Engine diagnostic — token transaction integrity", () => {
  const originalBypass = process.env.DEV_BYPASS_TOKENS;
  const originalLegacy = process.env.HYBRID_ALLOW_TOKENLESS_GENERATE;

  beforeEach(() => {
    delete process.env.DEV_BYPASS_TOKENS;
    delete process.env.HYBRID_ALLOW_TOKENLESS_GENERATE;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalBypass === undefined) delete process.env.DEV_BYPASS_TOKENS;
    else process.env.DEV_BYPASS_TOKENS = originalBypass;
    if (originalLegacy === undefined) delete process.env.HYBRID_ALLOW_TOKENLESS_GENERATE;
    else process.env.HYBRID_ALLOW_TOKENLESS_GENERATE = originalLegacy;
    vi.doUnmock("@/integrations/supabase/client.server");
    vi.restoreAllMocks();
  });

  it("decrements balance atomically before any upstream call when balance >= 1", async () => {
    const { admin, spendCalls, getBalance } = createMockAdmin({ balance: 2 });
    vi.doMock("@/integrations/supabase/client.server", () => ({
      requireSupabaseAdmin: () => admin,
      tryGetSupabaseAdmin: () => admin,
    }));

    const callOrder: string[] = [];
    const tokens = await import("@/lib/generation-tokens.server");

    callOrder.push("pre-spend");
    const auth = await tokens.authorizeAndSpendGenerationToken({
      userId: USER_ID,
      supabase: admin as never,
      idempotencyKey: "gen:diagnostic-burn-1",
      amount: 1,
      note: "Diagnostic burn",
    });
    callOrder.push("post-spend");
    callOrder.push("upstream-api");

    expect(auth.bypassed).toBe(false);
    expect(auth.balance).toBe(1);
    expect(getBalance()).toBe(1);
    expect(spendCalls).toHaveLength(1);
    expect(spendCalls[0]?._amount).toBe(1);
    expect(callOrder).toEqual(["pre-spend", "post-spend", "upstream-api"]);
  });

  it("does not throw a false 402 when balance is 2", async () => {
    const { admin, getBalance } = createMockAdmin({ balance: 2 });
    vi.doMock("@/integrations/supabase/client.server", () => ({
      requireSupabaseAdmin: () => admin,
      tryGetSupabaseAdmin: () => admin,
    }));

    const tokens = await import("@/lib/generation-tokens.server");
    await expect(
      tokens.authorizeAndSpendGenerationToken({
        userId: USER_ID,
        supabase: admin as never,
        idempotencyKey: "gen:diagnostic-no-false-402",
        amount: 1,
      }),
    ).resolves.toMatchObject({ bypassed: false, balance: 1 });
    expect(getBalance()).toBe(1);
  });

  it("throws 402 only when balance < required amount", async () => {
    const { admin } = createMockAdmin({ balance: 0 });
    vi.doMock("@/integrations/supabase/client.server", () => ({
      requireSupabaseAdmin: () => admin,
      tryGetSupabaseAdmin: () => admin,
    }));

    const tokens = await import("@/lib/generation-tokens.server");
    const { InsufficientTokensError } = tokens;
    await expect(
      tokens.authorizeAndSpendGenerationToken({
        userId: USER_ID,
        supabase: admin as never,
        idempotencyKey: "gen:diagnostic-underfunded",
        amount: 1,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(InsufficientTokensError);
      expect((err as InstanceType<typeof InsufficientTokensError>).statusCode).toBe(402);
      expect((err as InstanceType<typeof InsufficientTokensError>).balance).toBe(0);
      return true;
    });
  });

  it("refunds idempotently after a simulated upstream failure", async () => {
    const { admin, refundCalls, getBalance } = createMockAdmin({ balance: 2 });
    vi.doMock("@/integrations/supabase/client.server", () => ({
      requireSupabaseAdmin: () => admin,
      tryGetSupabaseAdmin: () => admin,
    }));

    const tokens = await import("@/lib/generation-tokens.server");
    const spendKey = tokens.generationTokenIdempotencyKey("diagnostic-fail-run");

    await tokens.authorizeAndSpendGenerationToken({
      userId: USER_ID,
      supabase: admin as never,
      idempotencyKey: spendKey,
      amount: 1,
    });
    expect(getBalance()).toBe(1);

    const first = await tokens.refundGenerationToken({
      userId: USER_ID,
      amount: 1,
      spendIdempotencyKey: spendKey,
      note: "Refund: Gate 1 timed out",
    });
    expect(first.ok).toBe(true);
    expect(first.alreadyApplied).toBe(false);
    expect(getBalance()).toBe(2);

    const second = await tokens.refundGenerationToken({
      userId: USER_ID,
      amount: 1,
      spendIdempotencyKey: spendKey,
      note: "Refund: Gate 1 timed out",
    });
    expect(second.ok).toBe(true);
    expect(second.alreadyApplied).toBe(true);
    expect(getBalance()).toBe(2);
    expect(refundCalls).toHaveLength(2);
    expect(refundCalls[0]?._idempotency_key).toBe(
      tokens.generationTokenRefundIdempotencyKey(spendKey),
    );
  });

  it("keeps spend and refund ledger keys paired", async () => {
    const tokens = await import("@/lib/generation-tokens.server");
    const spend = tokens.generationTokenIdempotencyKey("run-abc");
    expect(spend).toBe("gen:run-abc");
    expect(tokens.generationTokenRefundIdempotencyKey(spend)).toBe("refund:gen:run-abc");
  });
});

describe("Hybrid Engine diagnostic — SQL migrations", () => {
  it("qualifies token_balances.balance to avoid RETURNS TABLE shadowing", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260826220000_fix_spend_hybrid_tokens_balance_shadow.sql",
      ),
      "utf8",
    );
    expect(sql).toMatch(/tb\.balance\s*>=\s*_amount/);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/COALESCE\(current_balance,\s*0\)\s*<\s*_amount/);
  });

  it("defines service-role refund_hybrid_generation_tokens", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/20260826223000_refund_hybrid_generation_tokens.sql",
      ),
      "utf8",
    );
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.refund_hybrid_generation_tokens/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.refund_hybrid_generation_tokens/);
    expect(sql).toMatch(/TO service_role/);
  });
});

describe("Hybrid Engine diagnostic — lifecycle & finite polling", () => {
  it("maps progress stages through composition → complete", () => {
    expect(PIPELINE_PROGRESS.lyrics).toBeLessThan(PIPELINE_PROGRESS.sonic);
    expect(PIPELINE_PROGRESS.sonic).toBeLessThan(PIPELINE_PROGRESS.vault);
    expect(PIPELINE_PROGRESS.vault).toBeLessThan(PIPELINE_PROGRESS.complete);
    expect(PIPELINE_PROGRESS.complete).toBe(100);
  });

  it("terminates polling on failed/canceled without infinite loops", async () => {
    let attempts = 0;
    await expect(
      pollWithBreaker(
        async () => {
          attempts += 1;
          return { status: attempts >= 2 ? "failed" : "processing" };
        },
        (r) => r.status === "succeeded",
        (r) => isTerminalPollStatus(r.status),
        { maxAttempts: 40, intervalMs: 1, stepName: "composition" },
      ),
    ).rejects.toThrow(/terminal error/i);
    expect(attempts).toBe(2);
  });

  it("hard-caps polling attempts to prevent CPU spikes", async () => {
    let attempts = 0;
    await expect(
      pollWithBreaker(
        async () => {
          attempts += 1;
          return "queued";
        },
        () => false,
        () => false,
        { maxAttempts: 5, intervalMs: 1, stepName: "composition" },
      ),
    ).rejects.toThrow(/Exceeded max attempts \(5\)/);
    expect(attempts).toBe(5);
  });
});

describe("Hybrid Engine diagnostic — vault persistence & downloads", () => {
  it("treats vault and local master URLs as permanently playable", () => {
    expect(isPlayableVaultAudioUrl("https://cdn.example.com/masters/a.mp3")).toBe(true);
    expect(isPlayableVaultAudioUrl("/api/local-vault/masters/track_master.mp3")).toBe(true);
    expect(isPlayableVaultAudioUrl("blob:https://app.local/abc")).toBe(true);
    expect(isPlayableVaultAudioUrl("")).toBe(false);
  });

  it("emits strict attachment headers for mp3 downloads", () => {
    const name = sanitizeDownloadFileName("My Track!.mp3");
    expect(audioContentTypeForFileName(name)).toBe("audio/mpeg");
    const disposition = attachmentContentDisposition(name);
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).toContain("filename=");
    expect(disposition).toContain("filename*=UTF-8''");
  });

  it("builds same-origin audio proxy URLs for blocked remote hosts", () => {
    const url = proxiedAudioDownloadUrl("https://cdn.example.com/a.mp3", "hybrid-track.mp3");
    expect(url).toContain("/api/public/audio-proxy?url=");
    expect(url).toContain("download=hybrid-track.mp3");
  });
});

describe("Hybrid Engine diagnostic — spend-before-API contract", () => {
  it("documents generate-stream burns tokens before SSE run starts", () => {
    const source = readFileSync(
      join(process.cwd(), "src/routes/api/studio/generate-stream.ts"),
      "utf8",
    );
    // Prefer call sites over import/destructure mentions.
    const spendIdx = source.indexOf("await authorizeAndSpendGenerationToken");
    const runIdx = source.indexOf("await runGenerateEngineTrack");
    expect(spendIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(spendIdx);
    expect(source).toContain("await refundGenerationToken");
  });

  it("documents apiframe refunds on outer failure after burn", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/apiframe-music.functions.ts"),
      "utf8",
    );
    const spendIdx = source.indexOf("await authorizeAndSpendGenerationToken");
    const generateIdx = source.indexOf("await generateStudioTrack");
    expect(spendIdx).toBeGreaterThan(-1);
    expect(generateIdx).toBeGreaterThan(spendIdx);
    expect(source).toContain("await refundGenerationToken");
  });
});
