import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  CURRENCY_CODES,
  MAX_SURCHARGE_BPS,
  applySurchargeBps,
  currentSurchargeBps,
  type CurrencyCode,
} from "@/lib/pricing";

const bpsSchema = z.number().int().min(0).max(MAX_SURCHARGE_BPS);

const updateSchema = z.object({
  rates: z.record(z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]]), bpsSchema),
});

export type SurchargeSettings = {
  rates: Record<CurrencyCode, number>;
  updatedAt: string | null;
};

/** Public read: the storefront needs the live rates to quote prices. */
export const getSurchargeSettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<SurchargeSettings> => {
    const { readSurchargeSettings } = await import("@/lib/pricing-settings.server");
    return readSurchargeSettings();
  },
);

/** Admin-only write. The role check runs against the database, not the client. */
export const updateSurchargeSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => updateSchema.parse(data))
  .handler(async ({ data, context }): Promise<SurchargeSettings> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin"]);
    if (!roles || roles.length === 0) {
      const { recordPricingAccessAlert } = await import("@/lib/pricing-access-monitor.server");
      await recordPricingAccessAlert({
        actorRole: "authenticated",
        actorUserId: context.userId,
        source: "admin_settings_write",
        outcome: "denied",
        detail: "Non-admin account attempted to change the pricing surcharge settings.",
      });
      throw new Error("Forbidden");
    }

    const { writeSurchargeSettings } = await import("@/lib/pricing-settings.server");
    const saved = await writeSurchargeSettings(data.rates, context.userId);
    applySurchargeBps(saved.rates);
    return { rates: currentSurchargeBps(), updatedAt: saved.updatedAt };

  });

export type SurchargeAudit = {
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
};

/**
 * Admin-only: who last changed the surcharge. The `updated_by` identity is never
 * part of the public read path — the role check runs against the database first.
 */
export const getSurchargeAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SurchargeAudit> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin"]);
    if (!roles || roles.length === 0) {
      const { recordPricingAccessAlert } = await import("@/lib/pricing-access-monitor.server");
      await recordPricingAccessAlert({
        actorRole: "authenticated",
        actorUserId: context.userId,
        source: "admin_audit_read",
        outcome: "denied",
        detail: "Non-admin account attempted to read the pricing settings audit trail.",
      });
      throw new Error("Forbidden");
    }


    const { readSurchargeAudit } = await import("@/lib/pricing-settings.server");
    return readSurchargeAudit();
  });
