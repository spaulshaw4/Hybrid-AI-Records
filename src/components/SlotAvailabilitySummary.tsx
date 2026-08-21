import { useMemo } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, CircleSlash, RefreshCcw } from "lucide-react";
import type { BusyWindow } from "@/lib/vocal-session-availability.functions";

export type SummarySlot = { date: string; time: string };

/** Studio booking window (Hybrid AI Records engineering desk). */
const STUDIO_ZONE = "America/New_York";
const STUDIO_OPEN_HOUR = 10; // 10:00 ET
const STUDIO_CLOSE_HOUR = 20; // last session starts before 20:00 ET
const MIN_LEAD_HOURS = 48;

/** Offset (minutes) of `zone` at a given instant. */
function zoneOffsetMinutes(instant: Date, zone: string) {
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
}

/** Interpret a wall-clock date/time in `zone` and return the true instant. */
export function wallTimeToInstant(date: string, time: string, zone: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), zone) * 60000);
  // Second pass settles DST boundaries.
  instant = new Date(naive - zoneOffsetMinutes(instant, zone) * 60000);
  return instant;
}

type Verdict = "likely" | "possible" | "unlikely";

type Assessed = {
  slot: SummarySlot;
  instant: Date;
  studioLabel: string;
  verdict: Verdict;
  reason: string;
};

const VERDICT_META: Record<
  Verdict,
  { label: string; color: string; Icon: typeof CheckCircle2 }
> = {
  likely: { label: "Likely approved", color: "#3fbf6a", Icon: CheckCircle2 },
  possible: { label: "Possible", color: "#e2a13a", Icon: AlertTriangle },
  unlikely: { label: "Unlikely", color: "#e11d2e", Icon: CircleSlash },
};

/** Busy window (if any) covering the hour that contains `instant`. */
export function findBusyWindow(
  windows: BusyWindow[] | undefined,
  instant: Date,
): BusyWindow | null {
  if (!windows || windows.length === 0) return null;
  const hour = new Date(instant.getTime());
  hour.setUTCMinutes(0, 0, 0);
  const key = hour.toISOString();
  return windows.find((w) => w.startsAt === key) ?? null;
}

function assess(slot: SummarySlot, zone: string, windows?: BusyWindow[]): Assessed | null {
  const instant = wallTimeToInstant(slot.date, slot.time, zone);
  if (!instant || Number.isNaN(instant.getTime())) return null;

  const studioParts = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);

  const studioHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: STUDIO_ZONE,
      hour12: false,
      hour: "2-digit",
    }).format(instant) as unknown as string,
  );
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: STUDIO_ZONE,
    weekday: "short",
  }).format(instant);

  const leadHours = (instant.getTime() - Date.now()) / 3600000;

  let verdict: Verdict = "likely";
  let reason = "Inside studio hours with plenty of notice.";

  if (leadHours < 0) {
    verdict = "unlikely";
    reason = "This time has already passed.";
  } else if (weekday === "Sun") {
    verdict = "unlikely";
    reason = "Sundays are closed — Mon–Sat only.";
  } else if (studioHour < STUDIO_OPEN_HOUR || studioHour >= STUDIO_CLOSE_HOUR) {
    verdict = "unlikely";
    reason = `Outside studio hours (10:00–20:00 ${STUDIO_ZONE.split("/")[1]?.replace("_", " ")}).`;
  } else if (leadHours < MIN_LEAD_HOURS) {
    verdict = "possible";
    reason = "Less than 48 hours out — we'll confirm only if the desk is open.";
  } else if (weekday === "Sat") {
    verdict = "possible";
    reason = "Saturday sessions depend on engineer availability.";
  }

  // Real-time desk state overrides the static booking-window guess.
  const busy = findBusyWindow(windows, instant);
  if (busy && verdict !== "unlikely") {
    if (busy.kind === "confirmed") {
      verdict = "unlikely";
      reason = "Taken — another session is already confirmed in this hour.";
    } else {
      verdict = "possible";
      reason = `In demand — ${busy.count} other request${busy.count === 1 ? "" : "s"} for this hour.`;
    }
  } else if (!busy && verdict === "likely") {
    reason = "Open right now — inside studio hours with nothing else booked.";
  }

  return { slot, instant, studioLabel: studioParts, verdict, reason };
}

/**
 * Live read-out of how each proposed slot lands against the studio's booking
 * window, so the artist can see which times we're likely to confirm.
 */
export function SlotAvailabilitySummary({
  slots,
  timezone,
  windows,
  checkedAt,
  loading = false,
  onRefresh,
  className = "",
}: {
  slots: SummarySlot[];
  timezone: string;
  /** Live busy hours pulled from the booking desk. */
  windows?: BusyWindow[];
  checkedAt?: string | null;
  loading?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  const assessed = useMemo(
    () =>
      slots
        .filter((s) => s.date && s.time)
        .map((s) => assess(s, timezone, windows))
        .filter((a): a is Assessed => a !== null)
        .sort((a, b) => a.instant.getTime() - b.instant.getTime()),
    [slots, timezone, windows],
  );

  if (assessed.length === 0) return null;

  const strong = assessed.filter((a) => a.verdict === "likely").length;

  return (
    <div
      className={`border border-border-strong bg-background/50 p-4 backdrop-blur-sm ${className}`}
      aria-live="polite"
    >
      <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        <CalendarClock size={13} aria-hidden className="text-[#4b8bff]" />
        Live availability
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/60 transition-colors hover:text-white disabled:opacity-50"
          >
            <RefreshCcw size={11} aria-hidden className={loading ? "animate-spin" : ""} />
            {loading ? "Checking" : "Refresh"}
          </button>
        )}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-white/75">
        {strong > 0
          ? `${strong} of your ${assessed.length} slot${assessed.length > 1 ? "s" : ""} land squarely in our booking window.`
          : "None of your slots hit our main window yet — try a Mon–Sat time between 10:00 and 20:00 New York."}
      </p>

      <ul className="mt-4 space-y-3">
        {assessed.map((a, i) => {
          const meta = VERDICT_META[a.verdict];
          return (
            <li key={`${a.slot.date}-${a.slot.time}-${i}`} className="flex items-start gap-3">
              <meta.Icon size={15} aria-hidden style={{ color: meta.color }} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-mono text-xs text-white">
                  {a.slot.date} · {a.slot.time}{" "}
                  <span className="text-white/50">({timezone})</span>
                </p>
                <p className="mt-0.5 text-[11px] text-white/65">
                  Studio time: <span className="text-white/85">{a.studioLabel} ET</span>
                </p>
                <p className="mt-0.5 text-[11px]" style={{ color: meta.color }}>
                  {meta.label} — <span className="text-white/65">{a.reason}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {checkedAt && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
          Desk checked {new Date(checkedAt).toLocaleTimeString()}
        </p>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        Booking window: Mon–Sat, 10:00–20:00 New York time, at least 48 hours ahead. This is a
        guide — we confirm the final slot by email.
      </p>
    </div>
  );
}
