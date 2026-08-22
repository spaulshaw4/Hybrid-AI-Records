import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  clearClientErrorLog,
  readClientErrorLog,
  type StoredClientError,
} from "@/lib/client-error-log";
import { deviceContext } from "@/lib/client-breadcrumbs";
import { SafeModePanel } from "@/components/SafeModePanel";
import { PerformanceTimeline } from "@/components/PerformanceTimeline";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/diagnostics")({
  errorComponent: RouteErrorFallback,
  staticData: { noindex: true },
  component: DiagnosticsPage,
  head: () => ({
    meta: [
      { title: "Device Diagnostics — Hybrid AI Records" },
      {
        name: "description",
        content:
          "Review client-side error reports, stack traces and white-screen events recorded on this device by Hybrid Engine 1.0.",
      },
      { name: "robots", content: "noindex,nofollow" },
      { property: "og:title", content: "Device Diagnostics — Hybrid AI Records" },
      {
        property: "og:description",
        content: "Client error log and white-screen reports captured on this device.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function when(at: number): string {
  try {
    return new Date(at).toLocaleString();
  } catch {
    return String(at);
  }
}

function DiagnosticsPage() {
  const [entries, setEntries] = useState<StoredClientError[]>([]);
  const [device, setDevice] = useState<Record<string, string | number | boolean>>({});

  const refresh = useCallback(() => {
    setEntries(readClientErrorLog());
  }, []);

  useEffect(() => {
    refresh();
    setDevice(deviceContext());
  }, [refresh]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ device, entries }, null, 2));
      toast.success("Diagnostics copied to clipboard");
    } catch {
      toast.error("Clipboard blocked — select the text manually");
    }
  };

  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl px-5 py-10">
      <h1 className="text-3xl font-semibold text-foreground">Device diagnostics</h1>
      <p className="mt-2 text-muted-foreground">
        Every crash, unhandled rejection and white-screen detection captured in this browser. Kept
        on this device only; the same reports are also sent to our server logs.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
        >
          Refresh
        </button>
        <button
          type="button"
          onClick={copyAll}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Copy report
        </button>
        <button
          type="button"
          onClick={() => {
            clearClientErrorLog();
            refresh();
            toast.success("Local error log cleared");
          }}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-muted-foreground"
        >
          Clear log
        </button>
        {import.meta.env.DEV ? (
          <button
            type="button"
            onClick={() => {
              throw new Error("Sentry Test Error");
            }}
            className="rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive"
          >
            Send test error to Sentry
          </button>
        ) : null}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-foreground">This device</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {Object.entries(device).map(([key, value]) => (
            <div key={key}>
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="font-mono text-foreground">{String(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <SafeModePanel />

      <PerformanceTimeline />

      <section className="mt-10 space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Recorded events {entries.length > 0 ? `(${entries.length})` : ""}
        </h2>
        {entries.length === 0 ? (
          <p className="text-muted-foreground">
            No errors recorded on this device. That is the result we want.
          </p>
        ) : (
          entries.map((entry) => (
            <details
              key={entry.id}
              className="rounded-lg border border-border bg-card p-4 text-sm text-foreground"
            >
              <summary className="cursor-pointer list-none">
                <span className="font-medium">{entry.name}</span>{" "}
                <span className="text-muted-foreground">{entry.message}</span>
                <div className="mt-1 text-xs text-muted-foreground">
                  {when(entry.at)} · {entry.severity} · {entry.source} · {entry.route}
                  {entry.reference ? ` · ${entry.reference}` : ""}
                </div>
              </summary>
              {entry.stack ? (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                  {entry.stack}
                </pre>
              ) : null}
              {entry.componentStack ? (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                  {entry.componentStack}
                </pre>
              ) : null}
              {entry.breadcrumbs ? (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
                  {entry.breadcrumbs}
                </pre>
              ) : null}
            </details>
          ))
        )}
      </section>
    </main>
  );
}
