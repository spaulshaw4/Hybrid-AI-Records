import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  clearPerfEvents,
  getPerfSummary,
  subscribePerfEvents,
  type PerfEvent,
} from "@/lib/perf-watch";
import { readClientErrorLog } from "@/lib/client-error-log";
import { readSafeModeIncidents } from "@/lib/webkit-safe-mode";

type Row = {
  at: number;
  lane: "perf" | "error" | "safe-mode";
  label: string;
  detail?: string;
  severity: "info" | "warn" | "severe";
};

const KIND_LABEL: Record<PerfEvent["kind"], string> = {
  "long-task": "Main thread blocked",
  "frame-drop": "Dropped frames",
  "memory-pressure": "Memory pressure",
  freeze: "Page frozen by iOS",
  resume: "Page resumed",
  "bfcache-restore": "Restored from back/forward cache",
  "slow-interaction": "Slow interaction",
};

const LANE_STYLE: Record<Row["lane"], string> = {
  perf: "border-l-primary/70",
  error: "border-l-destructive",
  "safe-mode": "border-l-amber-400/80",
};

const SEVERITY_STYLE: Record<Row["severity"], string> = {
  info: "text-muted-foreground",
  warn: "text-amber-300",
  severe: "text-destructive",
};

function clock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return String(at);
  }
}

function unit(event: PerfEvent): string {
  if (event.kind === "frame-drop") return `${event.value} fps`;
  if (event.kind === "memory-pressure") return `${event.value}${event.value <= 100 ? "%" : " ms"}`;
  if (event.value > 0) return `${event.value} ms`;
  return "";
}

/**
 * Correlated diagnostics timeline: runtime performance samples (long tasks,
 * dropped frames, memory pressure, freeze/resume) interleaved with crash
 * reports and Safe Mode incidents, so a blank screen can be read against the
 * jank that preceded it.
 */
export function PerformanceTimeline() {
  const [perfEvents, setPerfEvents] = useState<PerfEvent[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => subscribePerfEvents(setPerfEvents), []);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const rows = useMemo<Row[]>(() => {
    void version;
    const perfRows: Row[] = perfEvents.map((event) => ({
      at: event.at,
      lane: "perf",
      severity: event.severity,
      label: KIND_LABEL[event.kind] ?? event.kind,
      detail: [unit(event), event.route, event.detail].filter(Boolean).join(" · "),
    }));

    const errorRows: Row[] = readClientErrorLog().map((entry) => ({
      at: entry.at,
      lane: "error",
      severity: entry.severity === "fatal" ? "severe" : "warn",
      label: `${entry.name}: ${entry.message}`,
      detail: [entry.source, entry.route, entry.reference].filter(Boolean).join(" · "),
    }));

    const incidentRows: Row[] = readSafeModeIncidents().map((incident) => ({
      at: incident.t,
      lane: "safe-mode",
      severity: "warn",
      label: `Safe Mode incident · ${incident.kind}`,
    }));

    return [...perfRows, ...errorRows, ...incidentRows].sort((a, b) => b.at - a.at).slice(0, 80);
  }, [perfEvents, version]);

  const summary = getPerfSummary();

  return (
    <section className="mt-10 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Performance timeline</h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Live runtime health for this device — blocked frames, stalls and memory pressure —
            merged with crash reports and Safe Mode incidents in one time-ordered list.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              clearPerfEvents();
              refresh();
              toast.success("Performance timeline cleared");
            }}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground"
          >
            Clear
          </button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Samples</dt>
          <dd className="font-mono text-foreground">{summary.events}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Severe</dt>
          <dd className="font-mono text-foreground">{summary.severe}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Longest stall</dt>
          <dd className="font-mono text-foreground">{summary.longestTaskMs} ms</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Worst frame rate</dt>
          <dd className="font-mono text-foreground">
            {summary.worstFps !== undefined ? `${summary.worstFps} fps` : "—"}
          </dd>
        </div>
      </dl>

      <ol className="mt-5 space-y-2">
        {rows.length === 0 ? (
          <li className="text-sm text-muted-foreground">
            Nothing recorded yet. Stalls, dropped frames and crashes appear here as they happen.
          </li>
        ) : (
          rows.map((row, index) => (
            <li
              key={`${row.at}-${row.lane}-${index}`}
              className={`rounded-r border-l-4 bg-muted/40 px-3 py-2 text-sm ${LANE_STYLE[row.lane]}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs text-muted-foreground">{clock(row.at)}</span>
                <span className={`font-medium ${SEVERITY_STYLE[row.severity]}`}>{row.label}</span>
              </div>
              {row.detail ? (
                <div className="mt-0.5 break-words text-xs text-muted-foreground">{row.detail}</div>
              ) : null}
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
