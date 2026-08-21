import { useEffect, useRef } from "react";
import { recordClientError } from "@/lib/client-error-log";
import { logTelemetry, recordRender } from "@/lib/render-telemetry";

export interface RenderLoopGuardOptions {
  /** Max renders allowed inside `windowMs` before the guard trips. */
  limit?: number;
  /** Rolling window in ms. Renders older than this are forgotten. */
  windowMs?: number;
  /** Extra diagnostic context written into the log entry. */
  context?: () => Record<string, unknown>;
  /** Called once when the guard trips, e.g. to freeze background polling. */
  onTrip?: (report: RenderLoopReport) => void;
}

export interface RenderLoopReport {
  label: string;
  renders: number;
  windowMs: number;
  sinceFirstMs: number;
  totalRenders: number;
  context: Record<string, unknown>;
}

/**
 * Loop-detection safeguard.
 *
 * Counts how many times a component commits inside a rolling window. A healthy
 * studio screen repaints a handful of times per second at most; anything past
 * the cap means a state update is feeding itself (unstable dependency array,
 * an effect that sets the state it reads, or an error boundary re-mounting).
 *
 * When the cap is exceeded the guard logs one clear diagnostic — to the console
 * and to the persistent client error log so it can be reviewed at /diagnostics
 * on the device where it happened — and refuses to log again until the render
 * rate settles, so the safeguard can never become the loop itself.
 */
export function useRenderLoopGuard(label: string, options: RenderLoopGuardOptions = {}) {
  const { limit = 60, windowMs = 1000, context, onTrip } = options;

  const stamps = useRef<number[]>([]);
  const total = useRef(0);
  const tripped = useRef(false);
  const optsRef = useRef({ context, onTrip });
  optsRef.current = { context, onTrip };

  // Counting happens during render (that is the event being measured); the
  // reporting side-effect runs after commit so it never mutates render output.
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  total.current += 1;
  stamps.current.push(now);
  const cutoff = now - windowMs;
  while (stamps.current.length && stamps.current[0]! < cutoff) stamps.current.shift();
  const renders = stamps.current.length;
  const overLimit = renders > limit;
  const settled = renders <= Math.max(1, Math.floor(limit / 2));

  // Feed the debug overlay: every instrumented commit is counted, together
  // with the current per-second rate for this component.
  recordRender(label, renders);

  useEffect(() => {
    if (!overLimit) {
      if (tripped.current && settled) tripped.current = false;
      return;
    }
    if (tripped.current) return;
    tripped.current = true;

    const first = stamps.current[0] ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
    const report: RenderLoopReport = {
      label,
      renders: stamps.current.length,
      windowMs,
      sinceFirstMs: Math.round(now - first),
      totalRenders: total.current,
      context: optsRef.current.context?.() ?? {},
    };

    const message = `Render loop detected in "${label}": ${report.renders} renders in ${windowMs}ms (cap ${limit}).`;
    console.error(`[loop-guard] ${message}`, report);
    logTelemetry("loop-guard", message);
    recordClientError({
      severity: "non-fatal",
      source: "render-loop-guard",
      name: "RenderLoopDetected",
      message,
      route: typeof window === "undefined" ? undefined : window.location.pathname,
      extra: report as unknown as Record<string, unknown>,
    });

    optsRef.current.onTrip?.(report);
  }, [overLimit, settled, limit, windowMs, label]);

  return {
    /** Renders counted inside the current window. */
    renders,
    /** Total renders since mount. */
    totalRenders: total.current,
    /** True once the cap was exceeded and a diagnostic was logged. */
    tripped: tripped.current,
  };
}
