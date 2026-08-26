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
import { isDbLockOrUnexpectedSpendError } from "@/lib/engine-bounce-back";

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

type SpendRpcRow = {
  ok?: boolean | null;
  balance?: number | null;
  already_applied?: boolean | null;
  reason?: string | null;
};

/**
 * PostgREST fallback when `spend_hybrid_tokens` returns a paradoxical denial
 * (balance >= amount but ok=false) — classic PL/pgSQL OUT-column shadowing on
 * an unmigrated DB. Uses optimistic locking on `token_balances.balance`.
 */
async function debitHybridTokensViaAdminTable(input: {
  admin: DbClient;
  userId: string;
  amount: number;
  note: string;
  idempotencyKey: string;
}): Promise<GenerationTokenAuth | null> {
  const { admin, userId, amount, note, idempotencyKey: key } = input;

  const { data: priorLedger } = await admin
    .from("token_ledger")
    .select("id, balance_after")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (priorLedger) {
    const balance =
      typeof priorLedger.balance_after === "number"
        ? priorLedger.balance_after
        : await readTokenBalance(admin, userId);
    console.warn("[generation-tokens] table fallback: idempotent hit", { userId, key, balance });
    return { bypassed: false, balance, alreadyApplied: true, idempotencyKey: key };
  }

  // Ensure a row exists so the optimistic update can match.
  await admin.from("token_balances").upsert(
    { user_id: userId, balance: 0 },
    { onConflict: "user_id", ignoreDuplicates: true },
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readTokenBalance(admin, userId);
    if (current < amount) return null;

    const next = current - amount;
    const { data: updated, error: updateError } = await admin
      .from("token_balances")
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("balance", current)
      .select("balance")
      .maybeSingle();

    if (updateError) {
      console.error("[CRITICAL] table fallback balance update failed", {
        userId,
        amount,
        current,
        message: updateError.message,
        code: updateError.code,
        details: updateError.details,
      });
      return null;
    }
    if (!updated) continue; // lost race — retry

    const { error: ledgerError } = await admin.from("token_ledger").insert({
      user_id: userId,
      delta: -amount,
      kind: "generation",
      note,
      balance_after: updated.balance,
      idempotency_key: key,
    });

    if (ledgerError) {
      // Unique idempotency collision after a concurrent writer — treat as applied.
      if (ledgerError.code === "23505") {
        const balance = await readTokenBalance(admin, userId);
        return { bypassed: false, balance, alreadyApplied: true, idempotencyKey: key };
      }
      console.error("[CRITICAL] table fallback ledger insert failed", {
        userId,
        amount,
        key,
        message: ledgerError.message,
        code: ledgerError.code,
        details: ledgerError.details,
      });
      // Best-effort restore so we do not keep a silent debit without a ledger row.
      await admin
        .from("token_balances")
        .update({ balance: current, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("balance", updated.balance);
      return null;
    }

    console.warn("[generation-tokens] table fallback debit succeeded", {
      userId,
      amount,
      balance: updated.balance,
      key,
    });
    return {
      bypassed: false,
      balance: updated.balance,
      alreadyApplied: false,
      idempotencyKey: key,
    };
  }

  return null;
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

  const note = input.note || "Studio master generation";
  // Params must match SQL exactly: spend_hybrid_tokens(_user_id, _amount, _note, _idempotency_key).
  const rpcArgs = {
    _user_id: input.userId,
    _amount: amount,
    _note: note,
    _idempotency_key: key,
  } as const;
  const { data, error } = await admin.rpc("spend_hybrid_tokens", rpcArgs);

  // Prefer array form — `.maybeSingle()` can drop a valid SETOF row as PGRST116.
  const row = (Array.isArray(data) ? data[0] : data) as SpendRpcRow | null | undefined;

  const tryTableFallback = async (reason: string): Promise<GenerationTokenAuth | null> => {
    console.error("[CRITICAL] spend_hybrid_tokens RPC failure:", {
      reason,
      error: error
        ? {
            message: error.message,
            code: error.code,
            details: error.details,
            hint: error.hint,
          }
        : null,
      data,
      userId: input.userId,
      amount,
      priorBalance,
      rpcArgs,
      row,
    });
    return debitHybridTokensViaAdminTable({
      admin,
      userId: input.userId,
      amount,
      note,
      idempotencyKey: key,
    });
  };

  if (error) {
    console.error("[generation-tokens] spend_hybrid_tokens failed", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      rpcArgs,
      priorBalance,
      raw: data,
    });
    const latest = await readTokenBalance(admin, input.userId);
    if (latest >= amount) {
      const recovered = await tryTableFallback(
        isDbLockOrUnexpectedSpendError(error)
          ? "db_lock_or_contention"
          : "postgrest_error_with_valid_balance",
      );
      if (recovered) return recovered;
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
      rpcArgs,
      priorBalance,
      raw: data,
    });
    if (priorBalance >= amount) {
      const recovered = await tryTableFallback("empty_or_malformed_row");
      if (recovered) return recovered;
    }
    throw new InsufficientTokensError(
      "Could not update your token balance. Try again.",
      await readTokenBalance(admin, input.userId),
    );
  }

  if (!row.ok) {
    // Paradoxical 402: RPC reports insufficient while returned/prior balance still funds the burn.
    // Note: a reused idempotency key on the fixed SQL returns ok=true (already_applied), not 402.
    const reported = row.balance ?? priorBalance;
    console.error("[generation-tokens] spend_hybrid_tokens denied (402)", {
      rpcArgs,
      priorBalance,
      row,
      raw: data,
    });
    if (reported >= amount && priorBalance >= amount) {
      const recovered = await tryTableFallback("paradoxical_deny_valid_balance");
      if (recovered) return recovered;
    }
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
 * PostgREST credit fallback when `refund_hybrid_generation_tokens` is missing
 * or fails while we still need to return the artist's token.
 */
async function creditHybridTokensViaAdminTable(input: {
  admin: DbClient;
  userId: string;
  amount: number;
  note: string;
  idempotencyKey: string;
}): Promise<{ ok: boolean; balance: number; alreadyApplied: boolean }> {
  const { admin, userId, amount, note, idempotencyKey: key } = input;

  const { data: priorLedger } = await admin
    .from("token_ledger")
    .select("id, balance_after")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (priorLedger) {
    const balance =
      typeof priorLedger.balance_after === "number"
        ? priorLedger.balance_after
        : await readTokenBalance(admin, userId);
    return { ok: true, balance, alreadyApplied: true };
  }

  await admin.from("token_balances").upsert(
    { user_id: userId, balance: 0 },
    { onConflict: "user_id", ignoreDuplicates: true },
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readTokenBalance(admin, userId);
    const next = current + amount;
    const { data: updated, error: updateError } = await admin
      .from("token_balances")
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("balance", current)
      .select("balance")
      .maybeSingle();

    if (updateError) {
      console.error("[CRITICAL] table refund balance update failed", {
        userId,
        amount,
        message: updateError.message,
        code: updateError.code,
      });
      return { ok: false, balance: current, alreadyApplied: false };
    }
    if (!updated) continue;

    const { error: ledgerError } = await admin.from("token_ledger").insert({
      user_id: userId,
      delta: amount,
      kind: "refund",
      note,
      balance_after: updated.balance,
      idempotency_key: key,
    });

    if (ledgerError) {
      if (ledgerError.code === "23505") {
        return {
          ok: true,
          balance: await readTokenBalance(admin, userId),
          alreadyApplied: true,
        };
      }
      console.error("[CRITICAL] table refund ledger insert failed", {
        userId,
        amount,
        key,
        message: ledgerError.message,
        code: ledgerError.code,
      });
      await admin
        .from("token_balances")
        .update({ balance: current, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("balance", updated.balance);
      return { ok: false, balance: current, alreadyApplied: false };
    }

    console.warn("[generation-tokens] table refund fallback succeeded", {
      userId,
      amount,
      balance: updated.balance,
      key,
    });
    return { ok: true, balance: updated.balance, alreadyApplied: false };
  }

  return { ok: false, balance: await readTokenBalance(admin, userId), alreadyApplied: false };
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
  const note = input.note || "Refund for failed generation";
  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = requireSupabaseAdmin();

  const { data, error } = await admin.rpc("refund_hybrid_generation_tokens", {
    _user_id: input.userId,
    _amount: amount,
    _note: note,
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
    console.error("[CRITICAL] refund_hybrid_generation_tokens RPC failure:", {
      error,
      data,
      userId: input.userId,
      amount,
      refundKey,
    });
    return creditHybridTokensViaAdminTable({
      admin,
      userId: input.userId,
      amount,
      note,
      idempotencyKey: refundKey,
    });
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

