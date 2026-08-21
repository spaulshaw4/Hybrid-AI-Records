import { agoLabel } from "@/components/radio/SyncBadge";
import { RETRY_ERROR_LABELS, type RetryAttempt } from "@/lib/radio-retry-log";

/**
 * Sync History panel for the radio console.
 *
 * Extracted from RadioPlayer so the panel's states — failed resolutions with a
 * Retry flow, resolved cross-device timestamps, and the per-track audit trail —
 * can be rendered deterministically in the visual-regression harness. Purely
 * presentational: all data and callbacks come from the console.
 */

export type SyncEventKind = "play" | "pause" | "seek" | "resume" | "resolved";

export type SyncEvent = {
  key: string;
  kind: SyncEventKind;
  /** Playhead this action landed on, in seconds. */
  seconds: number;
  /** When the action happened on this device (epoch ms). */
  at: number;
  /** For resolved entries: the account timestamp that won, if known. */
  wonAt?: number;
  /** For resolved entries: which device's action won. */
  device?: string;
  /** For resolved entries: whether this device or the account held the winner. */
  winner?: "remote" | "local";
};

export type SyncFailure = { at: number; message: string };

export type HistoryGroup = {
  key: string;
  title: string;
  artist: string;
  saved: number;
  events: SyncEvent[];
};

export type Resolution = {
  key: string;
  title: string;
  artist: string;
  seconds: number;
  at: number;
  wonAt?: number;
  device: string;
  side: "remote" | "local";
};

export const HISTORY_LABELS: Record<SyncEventKind, string> = {
  play: "Play",
  pause: "Pause",
  seek: "Seek",
  resume: "Resume",
  resolved: "Resolved",
};

function fmt(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function SyncHistoryPanel({
  failures,
  resolutions,
  groups,
  hasHistory,
  retries = [],
  onClear,
  onRetry,
}: {
  failures: SyncFailure[];
  resolutions: Resolution[];
  groups: HistoryGroup[];
  hasHistory: boolean;
  /** Logged Retry presses: when, from which device, and how each one ended. */
  retries?: RetryAttempt[];
  onClear: () => void;
  onRetry: () => void;
}) {
  return (
    <div data-testid="radio-sync-history" className="mt-5 border-t border-border-strong pt-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="radio-label-blue min-w-0 font-mono text-[10px] uppercase tracking-[0.24em]">Sync History</div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full border border-border-strong bg-foreground/5 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-foreground/70 transition hover:border-primary hover:text-primary"
        >
          Clear
        </button>
      </div>

      {/* Failed resolutions on this device — retry from here */}
      {failures.length > 0 && (
        <div
          data-testid="radio-sync-failures"
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-primary/50 bg-primary/[0.08] p-3"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 font-mono text-[9px] uppercase tracking-[0.24em] text-primary">Sync Failed</div>
            <button
              type="button"
              data-testid="radio-history-retry"
              onClick={onRetry}
              className="rounded-full border border-primary bg-primary/10 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Retry
            </button>
          </div>
          <ul className="max-h-32 space-y-1 overflow-y-auto pe-1">
            {failures.map((f) => (
              <li key={f.at} className="flex items-baseline justify-between gap-2 font-mono text-[10px] text-foreground/80">
                <span className="min-w-0 flex-1 truncate normal-case">{f.message}</span>
                <span
                  className="shrink-0 tabular-nums uppercase tracking-[0.18em] text-muted-foreground"
                  title={new Date(f.at).toLocaleString()}
                >
                  {agoLabel(f.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Retry attempt log — every Retry press with its device and outcome */}
      {retries.length > 0 && (
        <div
          data-testid="radio-retry-log"
          className="mb-4 rounded-md border border-border-strong bg-foreground/[0.03] p-3"
        >
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.24em] text-foreground/70">
            Retry Attempts
          </div>
          <ul className="max-h-40 space-y-2 overflow-y-auto pe-1">
            {retries.map((r) => (
              <li
                key={r.id}
                data-testid="radio-retry-attempt"
                data-outcome={r.outcome}
                className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2"
              >
                <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/80 sm:flex-1">
                  {r.device}
                  {r.account ? <span className="text-muted-foreground normal-case"> · {r.account}</span> : null}
                </span>
                <span className="flex shrink-0 flex-wrap items-baseline gap-x-2 font-mono text-[9px] uppercase tracking-[0.18em]">
                  <span
                    className={
                      r.outcome === "success"
                        ? "text-accent"
                        : r.outcome === "error"
                          ? "text-status-accent"
                          : "text-muted-foreground"
                    }
                    title={r.error ?? undefined}
                  >
                    {r.outcome === "pending"
                      ? "Retrying…"
                      : r.outcome === "success"
                        ? `Succeeded · ${r.tracks ?? 0} ${r.tracks === 1 ? "track" : "tracks"}`
                        : RETRY_ERROR_LABELS[r.errorKind ?? "unknown"]}
                  </span>
                  {r.outcome === "success" && r.wonBy ? (
                    <span className="text-foreground/70">{r.wonBy} won</span>
                  ) : null}
                  {typeof r.durationMs === "number" ? (
                    <span className="tabular-nums text-muted-foreground">{Math.round(r.durationMs)}ms</span>
                  ) : null}
                  <span className="tabular-nums text-muted-foreground" title={new Date(r.at).toISOString()}>
                    {agoLabel(r.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}



      {/* Latest resolution per track — the winning timestamp and device */}
      <div className="mb-4 rounded-md border border-accent/40 bg-accent/[0.06] p-3">
        <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.24em] text-accent">Resolved Timestamps</div>
        {resolutions.length === 0 ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            No cross-device resolutions yet.
          </p>
        ) : (
          <ul data-testid="radio-resolutions" className="max-h-40 space-y-2 overflow-y-auto pe-1">
            {resolutions.map((r) => (
              <li
                key={r.key}
                className="flex flex-col gap-0.5 border-b border-border pb-2 last:border-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2"
              >
                <span className="min-w-0 truncate text-xs text-foreground sm:flex-1">
                  {r.title}
                  {r.artist ? <span className="text-muted-foreground"> · {r.artist}</span> : null}
                </span>
                <span className="flex shrink-0 flex-wrap items-baseline gap-x-2 font-mono text-[9px] uppercase tracking-[0.18em]">
                  <span className="text-accent tabular-nums">{fmt(r.seconds)}</span>
                  <span className="text-foreground/70">{r.side === "local" ? "This device" : r.device}</span>
                  <span className="text-muted-foreground tabular-nums" title={new Date(r.wonAt ?? r.at).toLocaleString()}>
                    {agoLabel(r.at)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!hasHistory ? (
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          No play, seek, or resolved timestamps recorded yet.
        </p>
      ) : (
        <ul className="max-h-72 space-y-3 overflow-y-auto pe-1">
          {groups.map((group) => (
            <li key={group.key} className="rounded-md border border-border-strong bg-foreground/[0.03] p-3">
              <div className="flex flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-2">
                <span className="min-w-0 truncate text-sm text-foreground sm:flex-1">{group.title}</span>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                  Resume {fmt(group.saved)}
                </span>
              </div>
              <span className="block truncate font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
                {group.artist}
              </span>
              <ul className="mt-2 space-y-1">
                {group.events.map((e, i) => (
                  <li
                    key={`${e.at}-${i}`}
                    className={`flex items-center justify-between gap-2 font-mono text-[10px] ${
                      e.kind === "resolved" ? "text-accent" : "text-foreground/75"
                    }`}
                  >
                    <span className="min-w-0 truncate uppercase tracking-[0.16em]">
                      {HISTORY_LABELS[e.kind]} · {fmt(e.seconds)}
                    </span>
                    <span
                      className="shrink-0 tabular-nums text-muted-foreground"
                      title={new Date(e.wonAt ?? e.at).toLocaleString()}
                    >
                      {agoLabel(e.at)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
