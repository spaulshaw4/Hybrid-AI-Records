/**
 * Read-side for the /start funnel: aggregates step views, step completions and
 * payment starts so staff can see where applicants drop off.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { summarizeFunnel, type RawFunnelEvent } from "@/lib/funnel-summary.server";
import type { FunnelSummary } from "@/lib/funnel-steps";
import {
  summarizeCtaClicks,
  type CtaClickSummary,
  type RawCtaRow,
} from "@/lib/cta-summary";


export const getFunnelSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) =>
    z
      .object({
        days: z.number().int().min(1).max(90).default(30),
        packageSlug: z.string().trim().max(64).nullable().default(null),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<FunnelSummary> => {
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const supabase = context.supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          gte: (
            c: string,
            v: string,
          ) => {
            limit: (
              n: number,
            ) => Promise<{ data: RawFunnelEvent[] | null; error: { message: string } | null }>;
          };
        };
      };
    };

    const { data: rows, error } = await supabase
      .from("funnel_events")
      .select("event, package_slug, step, visitor_session")
      .gte("created_at", since)
      .limit(10000);

    if (error) throw new Error(error.message);
    return summarizeFunnel(rows ?? [], data.days, data.packageSlug);
  });

/**
 * Click counts for the "See how it works — 3 steps" anchor CTA, grouped by the
 * service card the click came from.
 */
export const getHowItWorksCtaClicks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) =>
    z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<CtaClickSummary> => {
    const since = new Date(Date.now() - data.days * 86_400_000).toISOString();
    const supabase = context.supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (
            c: string,
            v: string,
          ) => {
            gte: (
              c: string,
              v: string,
            ) => {
              limit: (
                n: number,
              ) => Promise<{ data: RawCtaRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };

    const { data: rows, error } = await supabase
      .from("funnel_events")
      .select("package_slug, visitor_session, details")
      .eq("event", "cta_click")
      .gte("created_at", since)
      .limit(10000);

    if (error) throw new Error(error.message);
    return summarizeCtaClicks(rows ?? [], data.days);
  });
