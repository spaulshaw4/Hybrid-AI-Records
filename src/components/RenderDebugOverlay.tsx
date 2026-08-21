import { memo, useEffect, useState } from "react";
import { Activity, X } from "lucide-react";
import {
  COST_PER_SHOT_USD,
  getRenderTelemetry,
  performanceMatrix,

  resetRenderTelemetry,
  startFpsSampling,
  subscribeRenderTelemetry,
  type RenderTelemetry,
} from "@/lib/render-telemetry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function clock(at: number) {
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return String(at);
  }
}

function fpsTone(fps: number | null) {
  if (fps === null) return "text-muted-foreground";
  if (fps >= 50) return "text-emerald-400";
  if (fps >= 30) return "text-amber-300";
  return "text-destructive";
}

/**
 * Render debug overlay: live re-render counts, sampled frame rate, upstream
 * reconnect attempts and time-to-first-frame for the current run.
 *
 * Opt-in only — it is mounted by the studio and shown when `?debug=render` is
 * on the URL or the user opens it from the floating badge, so normal sessions
 * pay nothing beyond the (already running) counters.
 */
function RenderDebugOverlayBase({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // The studio flips `defaultOpen` after reading ?debug=render on mount.
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const [snapshot, setSnapshot] = useState<RenderTelemetry>(() => getRenderTelemetry());

  useEffect(() => {
    if (!open) return;
    const unsubscribe = subscribeRenderTelemetry(setSnapshot);
    const stopFps = startFpsSampling();
    setSnapshot(getRenderTelemetry());
    return () => {
      unsubscribe();
      stopFps();
    };
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border/70 bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-lg backdrop-blur transition-colors hover:text-foreground"
        aria-label="Open render performance overlay"
      >
        <Activity className="h-3.5 w-3.5 text-primary" aria-hidden />
        Render stats
      </button>
    );
  }

  const matrix = performanceMatrix(snapshot);
  const renderRows = Object.entries(snapshot.renders).sort((a, b) => b[1] - a[1]);
  const reconnectRows = Object.entries(snapshot.reconnects).sort((a, b) => b[1] - a[1]);

  return (
    <aside
      className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border/70 bg-card/95 p-4 text-xs shadow-2xl backdrop-blur"
      aria-label="Render performance instrumentation"
    >
      <header className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Activity className="h-4 w-4 text-primary" aria-hidden />
          Render telemetry
        </span>
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => resetRenderTelemetry()}
          >
            Reset
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setOpen(false)}
            aria-label="Close render performance overlay"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </span>
      </header>

      <dl className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-border/60 bg-background/50 p-2">
          <dt className="text-muted-foreground">Frame rate</dt>
          <dd className={cn("text-base font-semibold tabular-nums", fpsTone(snapshot.fps))}>
            {snapshot.fps === null ? "—" : `${snapshot.fps} fps`}
          </dd>
          <p className="text-[10px] text-muted-foreground">
            low {snapshot.minFps === null ? "—" : `${snapshot.minFps} fps`}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/50 p-2">
          <dt className="text-muted-foreground">Time to first frame</dt>
          <dd className="text-base font-semibold tabular-nums text-foreground">
            {snapshot.timeToFirstFrameMs === null
              ? snapshot.runStartedAt
                ? "measuring…"
                : "—"
              : `${(snapshot.timeToFirstFrameMs / 1000).toFixed(1)}s`}
          </dd>
        </div>
      </dl>

      <section className="mb-3">
        <h3 className="mb-1 font-semibold text-foreground">Performance matrix</h3>
        <dl className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border/60 bg-background/50 p-2">
            <dt className="text-muted-foreground">Avg block time</dt>
            <dd className="tabular-nums text-foreground">
              {matrix.avgBlockMs === null ? "—" : `${(matrix.avgBlockMs / 1000).toFixed(1)}s`}
            </dd>
            <p className="text-[10px] text-muted-foreground">
              {matrix.done} done • {matrix.failed} failed
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/50 p-2">
            <dt className="text-muted-foreground">Est. spend</dt>
            <dd className="tabular-nums text-foreground">${matrix.spendUsd.toFixed(3)}</dd>
            <p className="text-[10px] text-muted-foreground">
              ${COST_PER_SHOT_USD.toFixed(3)} / shot baseline
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/50 p-2">
            <dt className="text-muted-foreground">Upstream latency</dt>
            <dd className="tabular-nums text-foreground">
              {matrix.avgLatencyMs === null ? "—" : `${matrix.avgLatencyMs} ms`}
            </dd>
          </div>
          <div className="rounded-lg border border-border/60 bg-background/50 p-2">
            <dt className="text-muted-foreground">Retry backoff</dt>
            <dd className="tabular-nums text-foreground">
              {snapshot.backoffMs === 0 ? "—" : `${(snapshot.backoffMs / 1000).toFixed(1)}s`}
            </dd>
          </div>
        </dl>
      </section>

      <section className="mb-3">
        <h3 className="mb-1 font-semibold text-foreground">Re-renders</h3>
        {renderRows.length === 0 ? (
          <p className="text-muted-foreground">No instrumented components yet.</p>
        ) : (
          <ul className="space-y-1">
            {renderRows.map(([label, count]) => {
              const perSecond = snapshot.rendersPerSecond[label] ?? 0;
              return (
                <li key={label} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">{label}</span>
                  <span className="tabular-nums text-foreground">
                    {count}
                    <span
                      className={cn(
                        "ml-1 text-[10px]",
                        perSecond > 20 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      ({perSecond}/s)
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-3">
        <h3 className="mb-1 font-semibold text-foreground">Reconnect attempts</h3>
        {reconnectRows.length === 0 ? (
          <p className="text-muted-foreground">No retries this session.</p>
        ) : (
          <ul className="space-y-1">
            {reconnectRows.map(([label, count]) => (
              <li key={label} className="flex items-center justify-between gap-2">
                <span className="truncate text-muted-foreground">{label}</span>
                <span className="tabular-nums text-amber-300">{count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-semibold text-foreground">Log</h3>
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {snapshot.logs.length === 0 ? (
            <li className="text-muted-foreground">Nothing logged yet.</li>
          ) : (
            snapshot.logs.map((entry) => (
              <li key={`${entry.at}-${entry.message}`} className="text-muted-foreground">
                <span className="tabular-nums text-foreground/70">{clock(entry.at)}</span>{" "}
                <span className="text-primary/80">{entry.label}</span> {entry.message}
              </li>
            ))
          )}
        </ul>
      </section>
    </aside>
  );
}

export const RenderDebugOverlay = memo(RenderDebugOverlayBase);
