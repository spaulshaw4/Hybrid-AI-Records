import { useMemo } from "react";
import { ArrowRight, History } from "lucide-react";
import type { BookingRound } from "@/lib/vocal-session-booking";

export type HistorySlot = { date: string; time: string };

const key = (s: HistorySlot) => `${s.date} ${s.time}`;

function label(s: HistorySlot) {
  const d = new Date(`${s.date}T${s.time || "00:00"}`);
  if (Number.isNaN(d.getTime())) return key(s);
  return `${d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })} · ${s.time}`;
}

/**
 * Side-by-side view of the slots the artist asked for before and the ones they
 * are proposing now, so a reschedule never loses the earlier context.
 */
export function RescheduleHistory({
  rounds,
  currentSlots,
  timezone,
  confirmedSlot,
  className = "",
}: {
  rounds: BookingRound[];
  /** Slots currently in the form (draft) or in the latest sent round. */
  currentSlots: HistorySlot[];
  timezone: string;
  confirmedSlot?: { date?: string; time?: string } | null;
  className?: string;
}) {
  const previousRounds = useMemo(
    () => rounds.filter((r) => r.slots.length > 0),
    [rounds],
  );

  const previousKeys = useMemo(() => {
    const set = new Set<string>();
    for (const r of previousRounds) for (const s of r.slots) set.add(key(s));
    return set;
  }, [previousRounds]);

  const current = currentSlots.filter((s) => s.date && s.time);
  const currentKeys = new Set(current.map(key));
  const confirmedKey =
    confirmedSlot?.date && confirmedSlot?.time
      ? key({ date: confirmedSlot.date, time: confirmedSlot.time })
      : null;

  if (previousRounds.length === 0) return null;

  const dropped = Array.from(previousKeys).filter((k) => !currentKeys.has(k));

  return (
    <section
      className={`border border-border-strong bg-background/50 p-4 backdrop-blur-sm ${className}`}
      aria-label="Reschedule history"
    >
      <p className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        <History size={13} aria-hidden className="text-[#e11d2e]" />
        Reschedule history
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
        {/* Previously requested */}
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/50">
            Previously requested
          </p>
          <ol className="mt-2 space-y-3">
            {previousRounds.map((r) => (
              <li key={`${r.round}-${r.sentAt}`}>
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">
                  {r.round === 0 ? "Original" : `Reschedule #${r.round}`} ·{" "}
                  {new Date(r.sentAt).toLocaleDateString()}
                </p>
                <ul className="mt-1 space-y-1">
                  {r.slots.map((s, i) => {
                    const k = key(s);
                    const kept = currentKeys.has(k);
                    const isConfirmed = confirmedKey === k;
                    return (
                      <li
                        key={`${k}-${i}`}
                        className={`font-mono text-xs ${
                          isConfirmed
                            ? "text-[#3fbf6a]"
                            : kept
                              ? "text-white/80"
                              : "text-white/45 line-through"
                        }`}
                      >
                        {label(s)}
                        {isConfirmed && (
                          <span className="ml-2 not-italic no-underline">· confirmed</span>
                        )}
                        {!isConfirmed && kept && <span className="ml-2 text-white/45">· kept</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        </div>

        <ArrowRight
          size={16}
          aria-hidden
          className="hidden self-center text-[#4b8bff] md:block"
        />

        {/* New request */}
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/50">
            New request
          </p>
          {current.length === 0 ? (
            <p className="mt-2 text-xs text-white/55">
              Pick your new times above — they'll appear here next to the old ones.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {current.map((s, i) => {
                const isNew = !previousKeys.has(key(s));
                return (
                  <li key={`${key(s)}-${i}`} className="font-mono text-xs text-white/85">
                    {label(s)}
                    {isNew && <span className="ml-2 text-[#4b8bff]">· new</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
        All times shown in <span className="text-white/70">{timezone}</span>.{" "}
        {dropped.length > 0
          ? `${dropped.length} earlier time${dropped.length === 1 ? "" : "s"} will be dropped when you send.`
          : "Nothing from your earlier request has been dropped."}
        {confirmedKey
          ? " Your confirmed slot stays held until we approve one of the new times."
          : ""}
      </p>
    </section>
  );
}
