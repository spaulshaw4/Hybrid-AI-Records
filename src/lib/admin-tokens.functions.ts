import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const lookupSchema = z.object({ email: z.string().trim().email().max(320) });
const creditSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().min(1).max(100),
  reason: z.string().trim().max(300).optional(),
  /** Repeat calls with the same key are ignored by the database routine. */
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

export type TokenUser = {
  userId: string;
  email: string;
  balance: number;
};

export type TokenAuditEntry = {
  id: string;
  amount: number;
  reason: string | null;
  balanceAfter: number | null;
  createdAt: string;
};

/**
 * Role check runs server-side against `user_roles` through the caller's
 * RLS-scoped client — never anything the browser can assert.
 */
async function assertAdmin(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, value: string) => {
          eq: (col: string, value: string) => Promise<{ data: unknown[] | null }>;
        };
      };
    };
  },
  userId: string,
) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin");
  if (!data || data.length === 0) throw new Error("Forbidden");
}

export const lookupTokenUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => lookupSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await supabaseAdmin.rpc("admin_lookup_token_user", {
      target_email: data.email,
      acting_admin_id: context.userId,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return { user: null as TokenUser | null, history: [] as TokenAuditEntry[] };

    const user: TokenUser = {
      userId: row.user_id as string,
      email: (row.email as string) ?? data.email,
      balance: Number(row.balance ?? 0),
    };

    const { data: audit } = await supabaseAdmin
      .from("token_audit_log")
      .select("id, token_amount, reason, balance_after, created_at")
      .eq("user_id", user.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    const history: TokenAuditEntry[] = (audit ?? []).map((a) => ({
      id: a.id as string,
      amount: Number(a.token_amount ?? 0),
      reason: (a.reason as string | null) ?? null,
      balanceAfter: a.balance_after == null ? null : Number(a.balance_after),
      createdAt: a.created_at as string,
    }));

    return { user, history };
  });

export const creditUserTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => creditSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The database routine re-verifies the admin role for the acting user and
    // writes both the audit log and the token ledger in one transaction.
    const { data: rows, error } = await supabaseAdmin.rpc("credit_user_tokens", {
      target_user_id: data.userId,
      token_amount: data.amount,
      reason: data.reason ?? `Admin credit by ${context.userId}`,
      acting_admin_id: context.userId,
      idempotency_key: data.idempotencyKey,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(rows) ? rows[0] : null;
    const alreadyApplied = Boolean(row?.already_applied);
    if (!alreadyApplied) {
      const { notifyUser } = await import("./notifications.server");
      await notifyUser({
        userId: data.userId,
        kind: "token_credit",
        title: `${data.amount} Hybrid Token${data.amount === 1 ? "" : "s"} added`,
        body: `${data.amount} Hybrid Token${data.amount === 1 ? " was" : "s were"} credited to your account. New balance: ${Number(row?.balance ?? 0)}.${data.reason ? ` Reason: ${data.reason}` : ""}`,
        reference: data.idempotencyKey ?? null,
        emailless: true,
      });
      const { sendTokenPurchaseReceipt } = await import("./resend.server");
      await sendTokenPurchaseReceipt({
        userId: data.userId,
        amount: data.amount,
        balance: Number(row?.balance ?? 0),
        tokenKind: "hybrid",
      });
    }
    return {
      balance: Number(row?.balance ?? 0),
      alreadyApplied,
    };
  });

const refundSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().min(1).max(100),
  reason: z.string().trim().min(1).max(300),
  reference: z.string().trim().max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

/**
 * Reverses a failed generation: credits the same user back and records a
 * refund-labelled audit entry plus a `refund` ledger row.
 */
export const refundUserTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => refundSchema.parse(input))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await supabaseAdmin.rpc("refund_user_tokens", {
      target_user_id: data.userId,
      token_amount: data.amount,
      reason: data.reason,
      reference: data.reference,
      acting_admin_id: context.userId,
      idempotency_key: data.idempotencyKey,
    });
    if (error) throw new Error(error.message);
    const row = Array.isArray(rows) ? rows[0] : null;
    const alreadyApplied = Boolean(row?.already_applied);
    if (!alreadyApplied) {
      const { notifyUser } = await import("./notifications.server");
      await notifyUser({
        userId: data.userId,
        kind: "token_refund",
        title: `${data.amount} Hybrid Token${data.amount === 1 ? "" : "s"} refunded`,
        body: `We refunded ${data.amount} Hybrid Token${data.amount === 1 ? "" : "s"} to your account. New balance: ${Number(row?.balance ?? 0)}. Reason: ${data.reason}`,
        reference: data.reference ?? data.idempotencyKey ?? null,
      });
    }
    return {
      balance: Number(row?.balance ?? 0),
      alreadyApplied,
    };
  });

const ledgerSchema = z.object({
  email: z.string().trim().max(320).optional(),
  reason: z.string().trim().max(300).optional(),
  minAmount: z.number().int().min(-1000).max(1000).optional(),
  maxAmount: z.number().int().min(-1000).max(1000).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export type TokenLedgerRow = {
  id: string;
  userId: string;
  email: string | null;
  adminEmail: string | null;
  amount: number;
  reason: string | null;
  balanceAfter: number | null;
  createdAt: string;
};

/** Admin-only audit feed with email / reason / amount / date filters. */
export const listTokenAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => ledgerSchema.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows, error } = await supabaseAdmin.rpc("admin_list_token_audit", {
      email_filter: data.email || undefined,
      reason_filter: data.reason || undefined,
      min_amount: data.minAmount,
      max_amount: data.maxAmount,
      from_date: data.from ? new Date(data.from).toISOString() : undefined,
      to_date: data.to ? new Date(`${data.to}T23:59:59.999Z`).toISOString() : undefined,
      row_limit: data.limit ?? 200,
      acting_admin_id: context.userId,
    });
    if (error) throw new Error(error.message);

    const entries: TokenLedgerRow[] = (rows ?? []).map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      email: (r.email as string | null) ?? null,
      adminEmail: (r.admin_email as string | null) ?? null,
      amount: Number(r.token_amount ?? 0),
      reason: (r.reason as string | null) ?? null,
      balanceAfter: r.balance_after == null ? null : Number(r.balance_after),
      createdAt: r.created_at as string,
    }));
    return { entries };
  });
