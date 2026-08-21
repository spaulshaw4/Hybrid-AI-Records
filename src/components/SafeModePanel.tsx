import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useSafeMode } from "@/lib/use-safe-mode";
import {
  INCIDENT_THRESHOLD,
  clearSafeModeIncidents,
  readSafeModeIncidents,
  setSafeMode,
} from "@/lib/webkit-safe-mode";

const REASON_LABEL: Record<string, string> = {
  "white-screen": "repeated blank screens",
  "boundary-recovery": "repeated render recoveries",
  "overlay-collapse": "an overlay display collapse",
  jank: "sustained low frame rate",
  manual: "a manual switch",
  user: "you",
};

/**
 * Control surface for WebKit Safe Mode: shows why it engaged, what it turned
 * off, and lets the user flip it either way. Lives on /diagnostics because
 * that is where someone lands after a crash.
 */
export function SafeModePanel() {
  const state = useSafeMode();
  const [incidents, setIncidents] = useState<Array<{ t: number; kind: string }>>([]);

  const refresh = useCallback(() => setIncidents(readSafeModeIncidents()), []);
  useEffect(() => {
    refresh();
  }, [refresh, state.active, state.incidents]);

  return (
    <section className="mt-10 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Safe Mode{" "}
            <span className={state.active ? "text-primary" : "text-muted-foreground"}>
              {state.active ? "· on" : "· off"}
            </span>
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {state.active
              ? `Animations, glass blur and the living background are disabled on this device${
                  state.reason ? ` after ${REASON_LABEL[state.reason] ?? state.reason}` : ""
                }. Everything still works — it just renders flat, which is what stops Safari going white or black.`
              : `Full effects are running. Safe Mode switches on by itself after ${INCIDENT_THRESHOLD} display failures in half an hour.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            const next = !state.active;
            setSafeMode(next, "manual", false);
            refresh();
            toast.success(next ? "Safe Mode on — effects disabled" : "Effects restored");
          }}
          className={
            state.active
              ? "rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
              : "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          }
        >
          {state.active ? "Turn effects back on" : "Turn on Safe Mode"}
        </button>
      </div>

      <div className="mt-4 text-sm">
        <p className="text-muted-foreground">
          Display incidents in the last 30 minutes:{" "}
          <span className="font-mono text-foreground">{incidents.length}</span>
        </p>
        {incidents.length > 0 ? (
          <>
            <ul className="mt-2 space-y-1 font-mono text-xs text-muted-foreground">
              {incidents
                .slice()
                .reverse()
                .map((incident) => (
                  <li key={`${incident.t}-${incident.kind}`}>
                    {new Date(incident.t).toLocaleTimeString()} · {incident.kind}
                  </li>
                ))}
            </ul>
            <button
              type="button"
              onClick={() => {
                clearSafeModeIncidents();
                refresh();
                toast.success("Incident history cleared");
              }}
              className="mt-3 text-xs font-medium text-muted-foreground underline"
            >
              Clear incident history
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
