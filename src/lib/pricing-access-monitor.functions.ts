import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PricingAccessAlert } from "@/lib/pricing-access-monitor.server";

export type { PricingAccessAlert };

/** Admin-only: recent unexpected pricing access attempts, newest first. */
export const getPricingAccessAlerts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.undefined().or(z.null()).parse(data ?? undefined))
  .handler(async ({ context }): Promise<PricingAccessAlert[]> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden");

    const { readPricingAccessAlerts } = await import("@/lib/pricing-access-monitor.server");
    return readPricingAccessAlerts(25);
  });
