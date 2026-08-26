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

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row, error } = await supabaseAdmin
    .rpc("spend_hybrid_tokens", {
      _user_id: input.userId,
      _amount: amount,
      _note: input.note || "Studio master generation",
      _idempotency_key: key,
    })
    .maybeSingle();

  if (error || !row) {
    console.error("[generation-tokens] spend_hybrid_tokens failed", error?.message);
    throw new InsufficientTokensError(
      "Could not update your token balance. Try again.",
      await readTokenBalance(input.supabase, input.userId),
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
