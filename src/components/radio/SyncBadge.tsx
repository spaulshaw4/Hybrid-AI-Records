/**
 * The ARIA behaviour of this component is a binding contract:
 * docs/accessibility/sync-badge-aria-contract.md
 *
 * Roles, live regions, `aria-describedby` wiring, the absence of
 * `aria-expanded`, and the `aria-disabled`-not-`disabled` Retry button are all
 * load-bearing and test-enforced. Read the contract before changing them.
 */
import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, CloudCheck, Loader2, RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DeviceWin } from "@/lib/radio-positions";


export type ResolveState = {
  phase: "resolving" | "resolved" | "error";
  tracks: number;
  message?: string;
  /** Which device's action won each reconciled track. */
  winners?: DeviceWin[];
};

/** "12s ago" / "4m ago" / "2h ago" — compact enough for a dense log row. */
export function agoLabel(at: number, now: number = Date.now()) {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** Locale-stable UTC stamp so SSR HTML and the browser never disagree. */
function alignedStamp(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

/**
 * Names the device that won each timestamp conflict, so the sync badge tooltip
 * can say whether this device or the account's other device kept the position.
 */
export function winnersSummary(winners?: DeviceWin[]) {
  if (!winners || !winners.length) return "";
  return winners
    .map(
      (w) =>
        `${w.side === "local" ? "This device" : w.device} won ${w.count} track${w.count === 1 ? "" : "s"}${
          w.side === "remote" ? " (on the account)" : " (locally)"
        }`,
    )
    .join("; ");
}

export type SyncBadgeProps = {
  accountEmail: string;
  syncState: "idle" | "loading" | "synced";
  resolveState: ResolveState | null;
  conflictNotice: boolean;
  lastResolvedAt: number | null;
  /** Bumped by the host to refresh relative labels. */
  nowTick?: number;
  retrying: boolean;
  onRetry: () => void;
  /**
   * Forces the tooltip open/closed. Left undefined in the app so Radix keeps
   * its own hover/focus behaviour; harnesses and tests use it to pin the
   * tooltip for deterministic snapshots.
   */
  tooltipOpen?: boolean;
};

/** Tooltip copy, kept separate so tests can assert it without opening Radix. */
export function syncTooltipText({
  accountEmail,
  resolveState,
  conflictNotice,
  lastResolvedAt,
  nowTick,
}: Pick<
  SyncBadgeProps,
  "accountEmail" | "resolveState" | "conflictNotice" | "lastResolvedAt" | "nowTick"
>) {
  return [
    resolveState
      ? resolveState.phase === "resolving"
        ? `Comparing playback timestamps across your devices${
            winnersSummary(resolveState.winners) ? ` — ${winnersSummary(resolveState.winners)}` : ""
          }`
        : [
            resolveState.tracks
              ? `Kept the most recent play position for ${resolveState.tracks} track${resolveState.tracks === 1 ? "" : "s"}`
              : "A newer change from another device was restored",
            winnersSummary(resolveState.winners),
          ]
            .filter(Boolean)
            .join(" — ")
      : conflictNotice
        ? "A newer change from another device was restored"
        : `Mix synced to ${accountEmail}`,
    lastResolvedAt
      ? `Devices last aligned ${agoLabel(lastResolvedAt, nowTick)} (${alignedStamp(lastResolvedAt)})`
      : "",
  ]
    .filter(Boolean)
    .join(" — ");
}

/** Screen-reader sentence — the visible chips are shorthand. */
export function syncAnnouncement({
  syncState,
  resolveState,
  conflictNotice,
  lastResolvedAt,
  nowTick,
}: Pick<
  SyncBadgeProps,
  "syncState" | "resolveState" | "conflictNotice" | "lastResolvedAt" | "nowTick"
>) {
  const base = resolveState
    ? resolveState.phase === "resolving"
      ? "Resolving playback timestamps across your devices."
      : resolveState.tracks
        ? `Resolved. Kept the most recent play position for ${resolveState.tracks} track${resolveState.tracks === 1 ? "" : "s"}.`
        : "Resolved. A newer change from another device was restored."
    : syncState === "loading"
      ? "Syncing your mix."
      : conflictNotice
        ? "A newer mix from another device was restored."
        : "Mix synced.";
  const tail =
    lastResolvedAt && resolveState?.phase !== "resolving"
      ? ` Devices last aligned ${agoLabel(lastResolvedAt, nowTick)}.`
      : "";
  return `${base}${tail}`;
}

export function SyncBadge({
  accountEmail,
  syncState,
  resolveState,
  conflictNotice,
  lastResolvedAt,
  nowTick,
  retrying,
  onRetry,
  tooltipOpen,
}: SyncBadgeProps) {
  const busy = resolveState?.phase === "resolving" || syncState === "loading";
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const clusterRef = useRef<HTMLSpanElement | null>(null);
  // Both branches are controlled so close can be debounced. Retry sits beside
  // the chip inside the error trigger, so Radix would close on chip → Retry
  // without the focus guard below. Keys remount the Tooltip on phase flip.
  const pinned = tooltipOpen !== undefined;
  const [open, setOpen] = useState(false);
  const [heldClosed, setHeldClosed] = useState(false);
  const tooltipShown = pinned ? tooltipOpen : open && !heldClosed;
  // Headless Chromium hover paths jitter by a pixel or two and fire a
  // pointerleave/enter pair that would otherwise unmount the popper mid-assert.
  // Escape, Retry, and intentional blur still close immediately.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdClosedRef = useRef(false);
  const leftRetryRef = useRef(false);
  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };
  const setTooltipOpen = (next: boolean, immediate = false) => {
    if (pinned) return;
    if (next) {
      if (holdClosedRef.current) return;
      clearCloseTimer();
      setOpen(true);
      return;
    }
    // Tab chip → Retry looks like leaving the trigger. Keep the popper only
    // while Retry itself holds focus. Immediate closes (Escape, Retry click)
    // still win so a pointer activation cannot leave a stuck popper.
    if (!immediate && document.activeElement === retryRef.current) return;
    if (immediate) {
      clearCloseTimer();
      setOpen(false);
      return;
    }
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (document.activeElement === retryRef.current) return;
      setOpen(false);
    }, 80);
  };
  const handleOpenChange = (next: boolean) => {
    setTooltipOpen(next);
  };
  const releasePointerHold = () => {
    holdClosedRef.current = false;
    setHeldClosed(false);
  };
  const dismissSticky = () => {
    holdClosedRef.current = true;
    setHeldClosed(true);
    setTooltipOpen(false, true);
  };
  useEffect(() => () => clearCloseTimer(), []);
  // A failed retry unmounts and remounts this subtree, which would drop keyboard
  // focus to <body>. Remember the intent and restore it when Retry comes back.
  const wantsRetryFocus = useRef(false);
  const errored = resolveState?.phase === "error";
  // Stable ids so the Retry button can point at the failure reason and the
  // status chip at its tooltip copy — screen readers read the cause on focus.
  const uid = useId();
  const errorReasonId = `${uid}-sync-error`;
  const tooltipTextId = `${uid}-sync-detail`;

  useEffect(() => {
    // Only ever restore focus to an *enabled* Retry button. While `retrying` is
    // true the button is aria-disabled, and parking focus on an inert control
    // strands keyboard users. The `activeElement` guard means an unrelated
    // element that already holds focus is never overridden either — the intent
    // is only replayed when the remount dropped focus on <body>.
    if (!errored || retrying || !wantsRetryFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    retryRef.current?.focus();
  }, [errored, retrying]);



  if (resolveState?.phase === "error") {
    return (
      <TooltipProvider delayDuration={150} disableHoverableContent>
        <Tooltip key="error" open={tooltipShown} onOpenChange={handleOpenChange}>
          <TooltipTrigger asChild>
            {/*
              Presentational cluster, not the interactive chip. A focusable
              `role="alert"` that *contains* Retry is a nested-interactive
              axe failure. Chip and Retry stay siblings so Tab order is
              chip → Retry while the pill still looks like one control.
              `role="group"` overrides Radix TooltipTrigger's button role.
              `tabIndex={-1}` overrides a trigger tab stop so only the chip
              and Retry sit in the tab order.
            */}
            <span
              ref={clusterRef}
              role="group"
              tabIndex={-1}
              data-testid="radio-sync-error-cluster"
              onPointerLeave={releasePointerHold}
              onFocusCapture={(event) => {
                // Retry is a sibling of the chip, so focusing it does not hit
                // Radix's trigger-focus path. The chip still opens via Radix.
                if (pinned) return;
                if (event.target === retryRef.current) {
                  leftRetryRef.current = false;
                  setTooltipOpen(true);
                }
              }}
              onBlurCapture={(event) => {
                if (pinned) return;
                const next = event.relatedTarget;
                if (next instanceof Node && event.currentTarget.contains(next)) {
                  // Shift+Tab Retry → chip: dismiss (same as Radix leaving a
                  // nested button). Chip → Retry stays open via onFocusCapture.
                  if (event.target === retryRef.current) {
                    leftRetryRef.current = true;
                    setTooltipOpen(false, true);
                  }
                  return;
                }
                setTooltipOpen(false, true);
              }}
              onKeyDown={(event) => {
                if (pinned || event.key !== "Escape") return;
                setTooltipOpen(false, true);
              }}
              className="flex h-8 items-center gap-1.5 rounded-full border border-status-outline bg-destructive/10 px-3 text-status-accent outline-none has-[[data-testid=radio-sync-status]:focus-visible]:ring-2 has-[[data-testid=radio-sync-status]:focus-visible]:ring-status-outline has-[[data-testid=radio-sync-status]:focus-visible]:ring-offset-2 has-[[data-testid=radio-sync-status]:focus-visible]:ring-offset-background"
            >
              <span
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                aria-label={`Sync failed. ${resolveState.message ?? "Timestamp resolution failed."}`}
                // The chip is the live region for the failure; the tooltip repeats
                // the reason, so point at it rather than duplicating the sentence.
                aria-describedby={errorReasonId}
                tabIndex={0}
                data-testid="radio-sync-status"
                onFocus={() => {
                  if (leftRetryRef.current) {
                    leftRetryRef.current = false;
                    return;
                  }
                  setTooltipOpen(true);
                }}
                className="flex items-center gap-1.5 text-status-accent outline-none"
              >
                <AlertTriangle size={13} aria-hidden="true" />
                <span aria-hidden="true" className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">
                  Sync Failed
                </span>
                <span id={errorReasonId} className="sr-only">
                  {`Sync failed. ${resolveState.message ?? "Timestamp resolution failed."}`}
                </span>
              </span>

              <button
                type="button"
                ref={retryRef}
                onPointerDown={() => {
                  if (retrying) return;
                  dismissSticky();
                }}
                onClick={() => {
                  // aria-disabled instead of `disabled`: a real disabled attribute
                  // makes the browser blur the button the moment a retry starts,
                  // dumping keyboard focus on <body> during rapid retry churn.
                  if (retrying) return;
                  wantsRetryFocus.current = true;
                  // Activating Retry dismisses the popper so a pointer click
                  // cannot leave a stuck tooltip over the busy control.
                  dismissSticky();
                  onRetry();
                }}
                onFocus={() => {
                  wantsRetryFocus.current = true;
                }}
                onBlur={(e) => {
                  // Focus moving elsewhere on purpose clears the intent; an
                  // unmount (relatedTarget null) keeps it so we can restore.
                  if (e.relatedTarget) wantsRetryFocus.current = false;
                }}
                aria-disabled={retrying || undefined}
                aria-busy={retrying || undefined}
                // Retry is a sibling of the alert (not nested), so the name
                // change has to be its own assertive live region or AT never
                // hears that the retry started.
                aria-live={retrying ? "assertive" : undefined}
                aria-atomic={retrying ? true : undefined}
                // Focusing Retry reads the failure reason, so the action has
                // context without the user hunting for the alert text.
                aria-describedby={errorReasonId}
                data-testid="radio-sync-retry"
                aria-label={retrying ? "Retrying timestamp sync" : "Retry timestamp sync"}

                // While retrying, the busy state is shown with a dashed border
                // (not reduced opacity) so the label keeps WCAG AA contrast.
                className="ms-1 flex items-center gap-1 rounded-full border border-status-outline px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-status-accent outline-none transition hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-status-outline focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-disabled:cursor-default aria-disabled:border-dashed"
              >
                {retrying ? (
                  <>
                    <Loader2
                      size={11}
                      aria-hidden="true"
                      data-testid="radio-sync-retry-spinner"
                      className="animate-spin motion-reduce:hidden"
                    />
                    {/* Reduced motion: a static marker stands in for the spinner. */}
                    <span
                      aria-hidden="true"
                      data-testid="radio-sync-retry-static"
                      className="hidden motion-reduce:inline"
                    >
                      ⋯
                    </span>
                  </>
                ) : (
                  <RefreshCw size={11} aria-hidden="true" />
                )}
                {retrying ? "Retrying" : "Retry"}
              </button>
            </span>
          </TooltipTrigger>
          {/* Visual only: the chip already carries the same sentence via
              aria-describedby, so letting Radix announce the tooltip too would
              read the failure reason twice. */}
          <TooltipContent
            aria-hidden="true"
            data-testid="radio-sync-tooltip"
            side="bottom"
            className="max-w-[18rem] text-xs"
          >
            {resolveState.message ?? "Timestamp resolution failed"}
          </TooltipContent>

        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={150} disableHoverableContent>
      <Tooltip key="status" open={tooltipShown} onOpenChange={handleOpenChange}>
        <TooltipTrigger asChild>
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label={syncAnnouncement({ syncState, resolveState, conflictNotice, lastResolvedAt, nowTick })}
            // Announces "busy" while resolving instead of the spinner being silent.
            aria-busy={busy || undefined}
            aria-describedby={tooltipTextId}
            tabIndex={0}
            data-testid="radio-sync-status"
            onPointerLeave={releasePointerHold}
            onFocus={() => setTooltipOpen(true)}
            onKeyDown={(event) => {
              if (pinned || event.key !== "Escape") return;
              setTooltipOpen(false, true);
            }}

            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 outline-none transition focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
              resolveState
                ? "border-status-outline bg-accent/10 text-status-accent focus-visible:ring-status-outline"
                : "border-status-outline bg-primary/10 text-status-accent focus-visible:ring-status-outline"
            }`}
          >
            {busy ? (
              <>
                <Loader2
                  size={13}
                  aria-hidden="true"
                  data-testid="radio-sync-spinner"
                  className="animate-spin motion-reduce:hidden"
                />
                {/* Reduced motion: static progress label replaces the spinner. */}
                <span
                  aria-hidden="true"
                  data-testid="radio-sync-static-progress"
                  className="hidden shrink-0 rounded-full border border-current/40 px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.18em] opacity-80 motion-reduce:inline-block"
                >
                  In Progress
                </span>
              </>
            ) : (
              <CloudCheck size={13} aria-hidden="true" />
            )}
            <span aria-hidden="true" className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.18em]">
              {resolveState
                ? resolveState.phase === "resolving"
                  ? "Resolving…"
                  : resolveState.tracks
                    ? `Resolved ${resolveState.tracks}`
                    : "Resolved"
                : syncState === "loading"
                  ? "Syncing…"
                  : conflictNotice
                    ? "Newer Mix Restored"
                    : "Synced"}
            </span>
            {lastResolvedAt && resolveState?.phase !== "resolving" ? (
              <span
                aria-hidden="true"
                data-testid="radio-sync-last-resolved"
                key={nowTick}
                className="whitespace-nowrap border-s border-current/30 ps-1.5 font-mono text-[9px] uppercase tracking-[0.18em]"
              >
                {agoLabel(lastResolvedAt, nowTick)}
              </span>
            ) : null}
            <span className="sr-only">
              {syncAnnouncement({ syncState, resolveState, conflictNotice, lastResolvedAt, nowTick })}
            </span>
            {/* Always-present description target: the tooltip only exists in the
                DOM while open, so aria-describedby needs a stable node. */}
            <span id={tooltipTextId} className="sr-only">
              {syncTooltipText({ accountEmail, resolveState, conflictNotice, lastResolvedAt, nowTick })}
            </span>
          </span>
        </TooltipTrigger>
        {/* Visual only — see the error branch: the stable sr-only description
            on the chip is what screen readers announce. */}
        <TooltipContent
          aria-hidden="true"
          data-testid="radio-sync-tooltip"
          side="bottom"
          className="max-w-[20rem] text-xs"
        >
          {syncTooltipText({ accountEmail, resolveState, conflictNotice, lastResolvedAt, nowTick })}
        </TooltipContent>

      </Tooltip>
    </TooltipProvider>
  );
}
