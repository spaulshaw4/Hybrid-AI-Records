/**
 * Staff review queue for payments that were flagged during checkout
 * verification (amount mismatch) or duplicate-session detection.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const REVIEW_CURRENCIES = ["ZAR", "GBP", "EUR", "NGN", "USD"] as const;
export type ReviewCurrency = (typeof REVIEW_CURRENCIES)[number];

export type ReviewFlag = "amount_mismatch" | "duplicate_payment";

export type FlaggedSubmission = {
  reference: string;
  artist: string;
  email: string;
  packageLabel: string;
  flag: ReviewFlag;
  flagDetails: string | null;
  currency: string | null;
  amountLabel: string | null;
  paidAt: string | null;
  flaggedAt: string | null;
  paidSessionId: string | null;
  lastSessionId: string | null;
  lastPaymentError: string | null;
  status: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

const listSchema = z.object({
  currencies: z.array(z.enum(REVIEW_CURRENCIES)).max(5).default([]),
  state: z.enum(["open", "resolved", "all"]).default("open"),
  limit: z.number().int().min(1).max(200).default(100),
});

const resolveSchema = z.object({
  reference: z.string().trim().min(4).max(40),
  note: z.string().trim().max(2000).default(""),
  reopen: z.boolean().default(false),
});

/** Staff/admin gate, evaluated server-side against the caller's own roles. */
async function assertStaff(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, value: string) => {
          in: (col: string, values: string[]) => Promise<{ data: unknown[] | null }>;
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
    .in("role", ["admin", "staff"]);
  if (!data || data.length === 0) throw new Error("Forbidden");
}

export const listFlaggedPayments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => listSchema.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<{ submissions: FlaggedSubmission[] }> => {
    await assertStaff(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let query = supabaseAdmin
      .from("track_requests")
      .select(
        "reference_code, artist, email, package_label, status, review_flag, flag_details, flagged_at, flag_resolved_at, flag_resolution_note, payment_currency, paid_amount_label, paid_at, paid_session_id, last_payment_session_id, last_payment_error",
      )
      .not("review_flag", "is", null)
      .order("flagged_at", { ascending: false })
      .limit(data.limit);

    if (data.state === "open") query = query.is("flag_resolved_at", null);
    if (data.state === "resolved") query = query.not("flag_resolved_at", "is", null);
    if (data.currencies.length) query = query.in("payment_currency", data.currencies);

    const { data: rows, error } = await query;
    if (error) {
      console.error("Review queue load failed:", error.message);
      throw new Error("Couldn't load the review queue. Try again shortly.");
    }

    return {
      submissions: (rows ?? []).map((row) => ({
        reference: row.reference_code,
        artist: row.artist,
        email: row.email,
        packageLabel: row.package_label,
        flag: (row.review_flag as ReviewFlag) ?? "amount_mismatch",
        flagDetails: row.flag_details,
        currency: row.payment_currency,
        amountLabel: row.paid_amount_label,
        paidAt: row.paid_at,
        flaggedAt: row.flagged_at,
        paidSessionId: row.paid_session_id,
        lastSessionId: row.last_payment_session_id,
        lastPaymentError: row.last_payment_error,
        status: row.status,
        resolvedAt: row.flag_resolved_at,
        resolutionNote: row.flag_resolution_note,
      })),
    };
  });

export const resolveFlaggedPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => resolveSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("track_requests")
      .update(
        data.reopen
          ? {
              flag_resolved_at: null,
              flag_resolved_by: null,
              flag_resolution_note: data.note || null,
              updated_at: now,
            }
          : {
              flag_resolved_at: now,
              flag_resolved_by: context.userId,
              flag_resolution_note: data.note || "Checked against Stripe — cleared.",
              updated_at: now,
            },
      )
      .eq("reference_code", data.reference.trim().toUpperCase())
      .not("review_flag", "is", null);

    if (error) {
      console.error("Review resolve failed:", error.message);
      throw new Error("Couldn't save that review decision.");
    }
    return { ok: true as const, resolved: !data.reopen };
  });
