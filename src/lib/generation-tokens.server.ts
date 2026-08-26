/**
 * Universal Hybrid Token authorization for studio generation.
 *
 * Every standard account is charged on the server inside `spend_hybrid_tokens`
 * before the AI pipeline runs. Client-side balance checks are UX only — never
 * authoritative. Disconnect / refresh / frontend errors do not reverse a burn.
 *
 * Bypass is explicit only:
 *   - `DEV_BYPASS_TOKENS=true` (or legacy `HYBRID_ALLOW_TOKENLESS_GENERATE`)
 *   - Admin role with `preferences.tokenTestMode !== true`
 *     (admins turn Test Mode ON to burn tokens like end users)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

export class InsufficientTokensError extends Error {
  readonly statusCode = 402 as const;
  readonly balance: number;

  constructor(message = "You need at least 1 Hybrid Token to generate a track.", balance = 0) {
    super(message);
    this.name = "InsufficientTokensError";
    this.balance = balance;
  }
}

export type GenerationTokenAuth = {
  bypassed: boolean;
  balance: number;
  alreadyApplied: boolean;
  idempotencyKey: string;
};

type DbClient = SupabaseClient<Database>;

function envTokenBypass(): boolean {
  const v = process.env.DEV_BYPASS_TOKENS ?? process.env.HYBRID_ALLOW_TOKENLESS_GENERATE;
  return v === "1" || v === "true";
}

async function userIsAdmin(supabase: DbClient, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return Boolean(data);
}

/** Admins with Test Mode ON are charged like consumers. */
async function adminTokenTestMode(supabase: DbClient, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("user_id", userId)
    .maybeSingle();
  const prefs = (data?.preferences ?? {}) as Record<string, unknown>;
  return prefs.tokenTestMode === true;
}

/**
 * True when this account may generate without burning a Hybrid Token.
 * Never trusts the browser — only env + admin role + stored preference.
 */
export async function shouldBypassGenerationTokens(
  userId: string,
  supabase: DbClient,
): Promise<boolean> {
  if (envTokenBypass()) return true;
  if (!(await userIsAdmin(supabase, userId))) return false;
  // Admin default: bypass. Test Mode forces the real burn path.
  return !(await adminTokenTestMode(supabase, userId));
}

export async function readTokenBalance(supabase: DbClient, userId: string): Promise<number> {
  const { data } = await supabase
    .from("token_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.balance ?? 0;
}

/**
 * Atomically validates + burns one (or more) Hybrid Tokens for a generation.
 * Idempotent on `idempotencyKey` — retries / coalesced runs never double-charge.
 */
export async function authorizeAndSpendGenerationToken(input: {
  userId: string;
  supabase: DbClient;
  idempotencyKey: string;
  amount?: number;
  note?: string;
}): Promise<GenerationTokenAuth> {
  const amount = Math.trunc(input.amount ?? 1);
  const key = input.idempotencyKey.trim().slice(0, 120);
  if (!key) throw new Error("Generation token idempotency key is required.");

  if (await shouldBypassGenerationTokens(input.userId, input.supabase)) {
    const balance = await readTokenBalance(input.supabase, input.userId);
    return { bypassed: true, balance, alreadyApplied: false, idempotencyKey: key };
  }

  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = requireSupabaseAdmin();

  // Pre-read for clearer 402s when underfunded; never trust this alone for the debit.
  const priorBalance = await readTokenBalance(admin, input.userId);
  if (priorBalance < amount) {
    throw new InsufficientTokensError(
      "Not enough Hybrid Tokens. Buy more to keep generating.",
      priorBalance,
    );
  }

  const { data, error } = await admin.rpc("spend_hybrid_tokens", {
    _user_id: input.userId,
    _amount: amount,
    _note: input.note || "Studio master generation",
    _idempotency_key: key,
  });

  // Prefer array form — `.maybeSingle()` can drop a valid SETOF row as PGRST116.
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        ok?: boolean | null;
        balance?: number | null;
        already_applied?: boolean | null;
        reason?: string | null;
      }
    | null
    | undefined;

  if (error) {
    console.error("[generation-tokens] spend_hybrid_tokens failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      userId: input.userId,
      amount,
      priorBalance,
    });
    const latest = await readTokenBalance(admin, input.userId);
    // If funds remain, surface a retryable debit failure — not "insufficient".
    if (latest >= amount) {
      throw new InsufficientTokensError(
        "Could not update your token balance. Try again.",
        latest,
      );
    }
    throw new InsufficientTokensError(
      "Not enough Hybrid Tokens. Buy more to keep generating.",
      latest,
    );
  }

  if (!row || typeof row.ok !== "boolean") {
    console.error("[generation-tokens] spend_hybrid_tokens returned no row", {
      userId: input.userId,
      amount,
      priorBalance,
      data,
    });
    throw new InsufficientTokensError(
      "Could not update your token balance. Try again.",
      await readTokenBalance(admin, input.userId),
    );
  }

  if (!row.ok) {
    throw new InsufficientTokensError(
      row.reason ?? "Not enough Hybrid Tokens. Buy more to keep generating.",
      row.balance ?? 0,
    );
  }

  return {
    bypassed: false,
    balance: row.balance ?? 0,
    alreadyApplied: row.already_applied ?? false,
    idempotencyKey: key,
  };
}

export type TokenPolicyView = {
  bypassActive: boolean;
  isAdmin: boolean;
  tokenTestMode: boolean;
  /** When true, this account will burn tokens on generate. */
  willCharge: boolean;
  balance: number;
  envBypass: boolean;
};

export async function getGenerationTokenPolicy(
  userId: string,
  supabase: DbClient,
): Promise<TokenPolicyView> {
  const envBypass = envTokenBypass();
  const isAdmin = await userIsAdmin(supabase, userId);
  const tokenTestMode = isAdmin ? await adminTokenTestMode(supabase, userId) : false;
  const bypassActive = await shouldBypassGenerationTokens(userId, supabase);
  const balance = await readTokenBalance(supabase, userId);
  return {
    bypassActive,
    isAdmin,
    tokenTestMode,
    willCharge: !bypassActive,
    balance,
    envBypass,
  };
}

export async function setAdminTokenTestMode(
  userId: string,
  supabase: DbClient,
  enabled: boolean,
): Promise<TokenPolicyView> {
  if (!(await userIsAdmin(supabase, userId))) {
    throw new Error("Only admins can toggle token Test Mode.");
  }

  const { data: existing } = await supabase
    .from("profiles")
    .select("preferences")
    .eq("user_id", userId)
    .maybeSingle();

  const prefs = {
    ...((existing?.preferences ?? {}) as Record<string, unknown>),
    tokenTestMode: enabled,
  };

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: userId,
      preferences: prefs as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);

  return getGenerationTokenPolicy(userId, supabase);
}

/** Stable ledger key shared by authorize-at-queue and post-binary settlement. */
export function generationTokenIdempotencyKey(runKey: string): string {
  return `gen:${runKey.trim().slice(0, 100)}`;
}

/** Idempotent refund key paired with a prior spend key (`gen:…` → `refund:gen:…`). */
export function generationTokenRefundIdempotencyKey(spendKey: string): string {
  const trimmed = spendKey.trim().slice(0, 110);
  return trimmed.startsWith("refund:") ? trimmed : `refund:${trimmed}`;
}

/**
 * Credits tokens back after a failed upstream generation.
 * No-op when the burn was bypassed. Idempotent on the refund key.
 */
export async function refundGenerationToken(input: {
  userId: string;
  amount?: number;
  spendIdempotencyKey: string;
  note?: string;
}): Promise<{ ok: boolean; balance: number; alreadyApplied: boolean }> {
  const amount = Math.trunc(input.amount ?? 1);
  if (!Number.isFinite(amount) || amount < 1) {
    return { ok: false, balance: 0, alreadyApplied: false };
  }

  const refundKey = generationTokenRefundIdempotencyKey(input.spendIdempotencyKey);
  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = requireSupabaseAdmin();

  const { data, error } = await admin.rpc("refund_hybrid_generation_tokens", {
    _user_id: input.userId,
    _amount: amount,
    _note: input.note || "Refund for failed generation",
    _idempotency_key: refundKey,
  });

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        ok?: boolean | null;
        balance?: number | null;
        already_applied?: boolean | null;
        reason?: string | null;
      }
    | null
    | undefined;

  if (error || !row?.ok) {
    console.error("[generation-tokens] refund_hybrid_generation_tokens failed", {
      message: error?.message,
      code: error?.code,
      reason: row?.reason,
      userId: input.userId,
      amount,
      refundKey,
    });
    return {
      ok: false,
      balance: await readTokenBalance(admin, input.userId),
      alreadyApplied: false,
    };
  }

  console.info("[generation-tokens] refunded generation tokens", {
    userId: input.userId,
    amount,
    balance: row.balance,
    alreadyApplied: row.already_applied,
  });

  return {
    ok: true,
    balance: row.balance ?? 0,
    alreadyApplied: row.already_applied ?? false,
  };
}

