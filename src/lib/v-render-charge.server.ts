import { quoteVRender, V_TOKEN_SECONDS } from "@/lib/v-tokens";
import { V_RENDER_BETA } from "@/lib/v-beta";

export type VChargeOutcome = {
  ok: boolean;
  /** Tokens the render costs at the quoted duration. */
  tokens: number;
  seconds: number;
  /** Tokens actually deducted (0 during a beta grace render). */
  charged: number;
  balance: number;
  /** True when the render was allowed through without a full charge. */
  granted: boolean;
  error?: string;
};

/**
 * Charges V Tokens for a render.
 *
 * The RPC is `SECURITY DEFINER` and only executable by `service_role`, so it
 * must be called with the admin client — calling it as the signed-in user
 * fails with a permission error and used to surface as the generic
 * "Couldn't charge V Tokens" message.
 *
 * During the beta (`V_RENDER_BETA`) an insufficient balance or a wallet error
 * never blocks the render: the shortfall is granted and reported back so the
 * UI can say so plainly.
 */
export async function chargeVRender(
  userId: string,
  durationSeconds: number,
  idempotencyKey?: string,
): Promise<VChargeOutcome> {
  const quote = quoteVRender(durationSeconds);
  const base = { tokens: quote.tokens, seconds: quote.seconds };

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: balanceRow } = await supabaseAdmin
    .from("v_token_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  const balance = balanceRow?.balance ?? 0;

  // Developer / admin test mode: staff renders never touch the wallet, so
  // pipeline validation can run immediately without charge errors.
  const { data: roleRows } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "staff"]);
  if (roleRows && roleRows.length > 0) {
    return { ...base, ok: true, charged: 0, balance, granted: true };
  }

  const grant = (error?: string): VChargeOutcome => ({
    ...base,
    ok: V_RENDER_BETA,
    charged: 0,
    balance,
    granted: V_RENDER_BETA,
    ...(V_RENDER_BETA ? {} : { error: error ?? "Couldn't charge V Tokens. Try again." }),
  });

  if (balance < quote.tokens) {
    return grant(
      `This render costs ${quote.tokens} V Token${quote.tokens === 1 ? "" : "s"} and you have ${balance}. Top up ${quote.tokens - balance} more to continue.`,
    );
  }

  const { data: spend, error } = await supabaseAdmin
    .rpc("spend_v_tokens", {
      _user_id: userId,
      _amount: quote.tokens,
      _note: `V Engine render — ${Math.round(quote.seconds)}s (${quote.tokens} × ${V_TOKEN_SECONDS}s)`,
      ...(idempotencyKey ? { _idempotency_key: idempotencyKey } : {}),
    })
    .maybeSingle();

  if (error || !spend) {
    console.error("V Token spend failed:", error?.message);
    return grant();
  }
  if (!spend.ok) {
    return grant(
      spend.reason ??
        `This render costs ${quote.tokens} V Token${quote.tokens === 1 ? "" : "s"} and you have ${spend.balance ?? balance}.`,
    );
  }

  return {
    ...base,
    ok: true,
    charged: quote.tokens,
    balance: spend.balance ?? Math.max(0, balance - quote.tokens),
    granted: false,
  };
}

/**
 * Verifies (and charges) Video Tokens for a single shot render.
 *
 * Every paid video route must call this BEFORE any request goes out against
 * `GOOGLE_PAID_API_KEY` or the motion engines. Free Hybrid tasks (script
 * writing, prompt parsing, metadata analysis) never call it.
 */
export async function requireVideoTokens(
  userId: string,
  durationSeconds: number,
  idempotencyKey?: string,
): Promise<VChargeOutcome> {
  return chargeVRender(userId, durationSeconds, idempotencyKey);
}

/**
 * Verifies Video Token access WITHOUT charging.
 *
 * Visual Engine's orchestration calls (script writing, style tuning, concept
 * boards, scene planning) run on `GOOGLE_PAID_API_KEY`, so the caller must hold
 * a usable Video Token balance before any of those requests fire. Tokens are
 * only deducted at render time by `requireVideoTokens`.
 */
export async function assertVideoTokenAccess(
  userId: string,
): Promise<{ ok: boolean; balance: number; error?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: roleRows } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .in("role", ["admin", "staff"]);
  if (roleRows && roleRows.length > 0) return { ok: true, balance: 0 };

  const { data: balanceRow } = await supabaseAdmin
    .from("v_token_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  const balance = balanceRow?.balance ?? 0;

  if (balance > 0 || V_RENDER_BETA) return { ok: true, balance };
  return {
    ok: false,
    balance,
    error: "Visual Engine runs on Video Tokens. Top up to start a paid session.",
  };
}
