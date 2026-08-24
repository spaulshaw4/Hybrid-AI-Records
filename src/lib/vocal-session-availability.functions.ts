import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({
  /** Booking chain to ignore, so your own held times never look "taken". */
  excludeRequestId: z.string().uuid().nullable().optional(),
});

export type BusyWindow = {
  /** UTC instant of the start of the busy hour. */
  startsAt: string;
  /** `confirmed` = locked by the studio, `requested` = another artist asked for it. */
  kind: "confirmed" | "requested";
  /** How many other requests are stacked on this hour. */
  count: number;
};

export type AvailabilitySnapshot = {
  windows: BusyWindow[];
  checkedAt: string;
};

/** Offset (minutes) of `zone` at a given instant. */
function zoneOffsetMinutes(instant: Date, zone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const asUTC = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return (asUTC - instant.getTime()) / 60000;
  } catch {
    return 0;
  }
}

/** Wall-clock date/time in `zone` → true UTC instant, rounded down to the hour. */
function toHourInstant(date: unknown, time: unknown, zone: string): string | null {
  if (typeof date !== "string" || typeof time !== "string") return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), zone) * 60000);
  instant = new Date(naive - zoneOffsetMinutes(instant, zone) * 60000);
  if (Number.isNaN(instant.getTime())) return null;
  instant.setUTCMinutes(0, 0, 0);
  return instant.toISOString();
}

/**
 * Public, privacy-safe availability read: which hours are already confirmed or
 * being requested by other artists. It returns only anonymous time buckets —
 * no names, emails, packages or notes.
 */
export const getVocalSessionAvailability = createServerFn({ method: "POST" })
  .validator((data: unknown) => input.parse(data ?? {}))
  .handler(async ({ data }): Promise<AvailabilitySnapshot> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const horizon = new Date(Date.now() - 6 * 3600_000).toISOString();

    const { data: rows, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .select("id, original_request_id, timezone, slots, confirmed_slot, status, created_at")
      .gte("created_at", new Date(Date.now() - 120 * 86_400_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(500);

    if (error || !rows) return { windows: [], checkedAt: new Date().toISOString() };

    const mine = data.excludeRequestId ?? null;
    const buckets = new Map<string, { confirmed: boolean; count: number }>();

    for (const row of rows) {
      if (mine && (row.id === mine || row.original_request_id === mine)) continue;
      if (row.status === "cancelled" || row.status === "declined") continue;
      const zone = row.timezone || "UTC";

      const confirmed = row.confirmed_slot as { date?: string; time?: string } | null;
      if (confirmed?.date && confirmed?.time) {
        const key = toHourInstant(confirmed.date, confirmed.time, zone);
        if (key && key >= horizon) {
          const prev = buckets.get(key) ?? { confirmed: false, count: 0 };
          buckets.set(key, { confirmed: true, count: prev.count });
        }
        continue;
      }

      const slots = Array.isArray(row.slots) ? row.slots : [];
      for (const slot of slots as Array<{ date?: string; time?: string }>) {
        const key = toHourInstant(slot?.date, slot?.time, zone);
        if (!key || key < horizon) continue;
        const prev = buckets.get(key) ?? { confirmed: false, count: 0 };
        buckets.set(key, { confirmed: prev.confirmed, count: prev.count + 1 });
      }
    }

    const windows: BusyWindow[] = Array.from(buckets.entries())
      .map(([startsAt, v]) => ({
        startsAt,
        kind: v.confirmed ? ("confirmed" as const) : ("requested" as const),
        count: v.count,
      }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    return { windows, checkedAt: new Date().toISOString() };
  });
