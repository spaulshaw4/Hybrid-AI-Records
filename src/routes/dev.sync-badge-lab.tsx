import { useEffect, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";
import { createFileRoute } from "@tanstack/react-router";
import { SyncBadge, type ResolveState } from "@/components/radio/SyncBadge";

/**
 * Interactive lab for the radio sync badge.
 *
 * Unlike /dev/sync-badge (a static grid of every state), this page renders a
 * single badge whose surrounding conditions are switched from the UI: theme
 * (light/dark), tooltip forced open or closed, and the badge phase. Reduced
 * motion is a real media query, so the lab reports it live rather than faking
 * it — Playwright drives it with emulateMedia and the readout proves which
 * mode a snapshot was taken in. Internal only, noindex.
 */

export const Route = createFileRoute("/dev/sync-badge-lab")({
  beforeLoad: devOnlyBeforeLoad,
  head: () =>
    pageHead({
      path: "/dev/sync-badge-lab",
      title: "Sync Badge Lab — Hybrid AI Records Internal",
      description: "Interactive internal lab for the Hybrid AI Radio sync badge: theme, reduced motion and tooltip state.",
      socialTitle: "Sync Badge Lab — Hybrid AI Records Internal",
      socialDescription: "Interactive internal lab for the Hybrid AI Radio sync badge states.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: SyncBadgeLab,
});

/** Frozen offset keeps the badge's "1m ago" chip stable across runs. */
const LAST_RESOLVED = Date.now() - 61_000;

type Phase = {
  id: string;
  label: string;
  syncState: "idle" | "loading" | "synced";
  resolveState: ResolveState | null;
  conflictNotice?: boolean;
  lastResolvedAt?: number | null;
  retrying?: boolean;
};

const PHASES: Phase[] = [
  { id: "synced", label: "Synced", syncState: "synced", resolveState: null, lastResolvedAt: LAST_RESOLVED },
  { id: "syncing", label: "Syncing", syncState: "loading", resolveState: null, lastResolvedAt: null },
  {
    id: "resolving",
    label: "Resolving",
    syncState: "synced",
    resolveState: {
      phase: "resolving",
      tracks: 2,
      winners: [{ device: "Safari on iOS", count: 2, side: "remote" }],
    },
    lastResolvedAt: LAST_RESOLVED,
  },
  {
    id: "resolved",
    label: "Resolved",
    syncState: "synced",
    resolveState: {
      phase: "resolved",
      tracks: 3,
      winners: [
        { device: "Safari on iOS", count: 2, side: "remote" },
        { device: "Chrome on macOS", count: 1, side: "local" },
      ],
    },
    lastResolvedAt: LAST_RESOLVED,
  },
  {
    id: "conflict",
    label: "Newer mix restored",
    syncState: "synced",
    resolveState: null,
    conflictNotice: true,
    lastResolvedAt: LAST_RESOLVED,
  },
  {
    id: "error",
    label: "Sync failed",
    syncState: "synced",
    resolveState: {
      phase: "error",
      tracks: 0,
      message: "Couldn't compare playback timestamps from your other devices.",
    },
    lastResolvedAt: LAST_RESOLVED,
  },
  {
    id: "error-retrying",
    label: "Sync failed, retrying",
    syncState: "synced",
    resolveState: {
      phase: "error",
      tracks: 0,
      message: "Couldn't compare playback timestamps from your other devices.",
    },
    lastResolvedAt: LAST_RESOLVED,
    retrying: true,
  },
];

/** Live read of prefers-reduced-motion, including runtime changes. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

const controlClass =
  "rounded border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function Toggle({
  testId,
  label,
  on,
  onClick,
}: {
  testId: string;
  label: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={on}
      onClick={onClick}
      className={`${controlClass} ${
        on
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-surface text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function SyncBadgeLab() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [phaseId, setPhaseId] = useState<string>("resolved");
  const [retries, setRetries] = useState(0);
  const reducedMotion = useReducedMotion();

  const phase = PHASES.find((p) => p.id === phaseId) ?? PHASES[0]!;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-1 font-display text-xl uppercase tracking-[0.2em]">Sync badge lab</h1>
      <p className="mb-6 max-w-prose text-sm text-muted-foreground">
        Switch theme, phase and tooltip state. Reduced motion follows the system / emulated media
        query and is reported below.
      </p>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Toggle
          testId="lab-theme-toggle"
          label={`Theme: ${theme}`}
          on={theme === "light"}
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
        <Toggle
          testId="lab-tooltip-toggle"
          label={`Tooltip: ${tooltipOpen ? "open" : "closed"}`}
          on={tooltipOpen}
          onClick={() => setTooltipOpen((v) => !v)}
        />
        <span
          data-testid="lab-motion-readout"
          data-reduced-motion={reducedMotion ? "reduce" : "no-preference"}
          className="rounded border border-border bg-surface px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
        >
          {`Reduced motion: ${reducedMotion ? "on" : "off"}`}
        </span>
      </div>

      <div role="radiogroup" aria-label="Badge phase" className="mb-8 flex flex-wrap gap-2">
        {PHASES.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === phaseId}
            data-testid={`lab-phase-${p.id}`}
            onClick={() => setPhaseId(p.id)}
            className={`${controlClass} ${
              p.id === phaseId
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-surface text-muted-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <section
        data-testid="lab-stage"
        data-theme={theme}
        data-phase={phaseId}
        data-tooltip={tooltipOpen ? "open" : "closed"}
        className={`${
          theme === "light" ? "theme-light " : ""
        }flex min-h-[9rem] items-center justify-center rounded-lg border border-border bg-background p-10`}
      >
        <div data-testid="lab-badge" className="w-fit p-1">
          <SyncBadge
            accountEmail="listener@hybrid-ai-records.com"
            syncState={phase.syncState}
            resolveState={phase.resolveState}
            conflictNotice={phase.conflictNotice ?? false}
            lastResolvedAt={phase.lastResolvedAt ?? null}
            retrying={(phase.retrying ?? false) || retries > 0}
            onRetry={() => setRetries((n) => n + 1)}
            tooltipOpen={tooltipOpen ? true : undefined}
          />
        </div>
      </section>

      <span
        data-testid="lab-retry-count"
        className="mt-3 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
      >
        {`Retry fired ${retries}`}
      </span>
    </main>
  );
}
