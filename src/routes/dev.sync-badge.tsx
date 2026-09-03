import { useEffect, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";
import { createFileRoute } from "@tanstack/react-router";
import { SyncBadge, type ResolveState } from "@/components/radio/SyncBadge";

/**
 * Visual-regression harness for the radio sync badge.
 *
 * The badge normally only renders for a signed-in listener deep inside the
 * radio console, which makes its hover/focus/reduced-motion states awkward to
 * capture. This page renders every state side by side on both a dark and a
 * light surface so Playwright can screenshot them deterministically. It is
 * excluded from search engines and carries no product content.
 */

export const Route = createFileRoute("/dev/sync-badge")({
  // Client-only: SSR vs client clock/class drift used to abort hydration and
  // leave `data-hydrated="false"`, which flakes the whole a11y suite.
  ssr: false,
  beforeLoad: devOnlyBeforeLoad,
  head: () =>
    pageHead({
      path: "/dev/sync-badge",
      title: "Sync Badge States — Hybrid AI Records Internal",
      description: "Internal rendering harness for the Hybrid AI Radio sync badge: tooltip, focus ring and reduced-motion states.",
      socialTitle: "Sync Badge States — Hybrid AI Records Internal",
      socialDescription: "Internal rendering harness for the Hybrid AI Radio sync badge states.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: SyncBadgeHarness,
});

/**
 * Fixed relative to a frozen clock so the badge's "1m ago" label is identical
 * in SSR HTML and the first client render. `Date.now()` at module load drifts
 * between the long-lived Vite process and each browser bundle, which throws a
 * hydration mismatch in React 19 and leaves `data-hydrated` stuck on "false".
 */
const HARNESS_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const LAST_RESOLVED = HARNESS_NOW - 61_000;

type Case = {
  id: string;
  label: string;
  syncState: "idle" | "loading" | "synced";
  resolveState: ResolveState | null;
  conflictNotice?: boolean;
  lastResolvedAt?: number | null;
  retrying?: boolean;
};

const CASES: Case[] = [
  { id: "synced", label: "Synced", syncState: "synced", resolveState: null, lastResolvedAt: null },
  {
    id: "synced-aligned",
    label: "Synced with last-aligned time",
    syncState: "synced",
    resolveState: null,
    lastResolvedAt: LAST_RESOLVED,
  },
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

/**
 * `?tooltip=<theme>:<caseId>` pins one badge's tooltip open.
 *
 * Focus-opened tooltips are unreliable to screenshot: Radix closes on blur, and
 * parallel Playwright workers share one browser window, so a page that loses
 * window focus drops its tooltip mid-capture. Reading the param after mount
 * keeps SSR markup identical for every other spec.
 */
function usePinnedTooltip() {
  // Client-only route: read the query on the first paint so Playwright does
  // not race the post-hydration effect that used to leave tooltips closed.
  const [pinned, setPinned] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tooltip"),
  );
  useEffect(() => {
    setPinned(new URLSearchParams(window.location.search).get("tooltip"));
  }, []);
  return pinned;
}

function Surface({ theme }: { theme: "dark" | "light" }) {
  // Retry is inert in the static states, but the keyboard specs need to prove an
  // Enter/Space press actually fires it, so count presses per case and flip that
  // badge into its retrying state. Nothing renders until a press happens, so the
  // resting snapshots are unchanged.
  const [retries, setRetries] = useState<Record<string, number>>({});
  const pinned = usePinnedTooltip();



  return (
    <section
      data-testid={`badge-surface-${theme}`}
      className={`${theme === "light" ? "theme-light " : ""}rounded-lg border border-border bg-background p-6`}
    >
      <h2 className="mb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
        {theme} surface
      </h2>
      <ul className="space-y-5">
        {CASES.map((c) => (
          <li key={c.id} className="flex flex-col gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
              {c.label}
            </span>
            <div data-testid={`badge-${theme}-${c.id}`} className="w-fit p-1">
              <SyncBadge
                accountEmail="listener@hybrid-ai-records.com"
                syncState={c.syncState}
                resolveState={c.resolveState}
                conflictNotice={c.conflictNotice ?? false}
                lastResolvedAt={c.lastResolvedAt ?? null}
                nowTick={HARNESS_NOW}
                retrying={(c.retrying ?? false) || (retries[c.id] ?? 0) > 0}
                tooltipOpen={pinned === `${theme}:${c.id}` ? true : undefined}
                onRetry={() => setRetries((r) => ({ ...r, [c.id]: (r[c.id] ?? 0) + 1 }))}

              />
            </div>
            {retries[c.id] ? (
              <span
                data-testid={`retry-count-${theme}-${c.id}`}
                className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                {`Retry fired ${retries[c.id]}`}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A single badge whose phase can be driven from the test runner, used to prove
 * that rapid error → retrying → error → resolving → resolved churn keeps
 * keyboard focus on Retry and keeps announcing the right sentence. Static cases
 * above can't cover this because their phase never changes.
 */
type LiveState = {
  syncState: "idle" | "loading" | "synced";
  resolveState: ResolveState | null;
  conflictNotice: boolean;
  retrying: boolean;
  lastResolvedAt: number | null;
};

const ERROR_STATE: LiveState = {
  syncState: "synced",
  resolveState: {
    phase: "error",
    tracks: 0,
    message: "Couldn't compare playback timestamps from your other devices.",
  },
  conflictNotice: false,
  retrying: false,
  lastResolvedAt: null,
};

function LiveSurface() {
  const [state, setState] = useState<LiveState>(ERROR_STATE);
  const [retries, setRetries] = useState(0);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w["__hybridBadgeDrive"] = (patch: Partial<LiveState>) =>
      setState((s) => ({ ...s, ...patch }));
    w["__hybridBadgeRetries"] = () => retries;
    return () => {
      delete w["__hybridBadgeDrive"];
      delete w["__hybridBadgeRetries"];
    };
  }, [retries]);

  return (
    <section
      data-testid="badge-surface-live"
      className="rounded-lg border border-border bg-background p-6"
    >
      <h2 className="mb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
        driven surface
      </h2>
      <div data-testid="badge-live" className="w-fit p-1">
        <SyncBadge
          accountEmail="listener@hybrid-ai-records.com"
          syncState={state.syncState}
          resolveState={state.resolveState}
          conflictNotice={state.conflictNotice}
          lastResolvedAt={state.lastResolvedAt}
          nowTick={HARNESS_NOW}
          retrying={state.retrying}
          onRetry={() => setRetries((n) => n + 1)}
        />
      </div>
      <span
        data-testid="live-retry-count"
        className="mt-2 block font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
      >
        {`Retry fired ${retries}`}
      </span>
    </section>
  );
}

function SyncBadgeHarness() {
  // Hydration marker for E2E specs. Tooltips only respond to hover/focus once
  // React has attached its listeners; a Tab press or mouse move that lands
  // before that is swallowed with no follow-up event to recover from, so tests
  // wait for this flag instead of racing `networkidle`.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <>
      <main
        className="mx-auto max-w-4xl px-6 py-10"
        data-testid="sync-badge-harness"
        data-hydrated={hydrated ? "true" : "false"}
      >
        <h1 className="mb-6 text-xl font-semibold tracking-tight text-foreground">Sync badge states</h1>
        <div className="grid gap-6 md:grid-cols-2">
          <Surface theme="dark" />
          <Surface theme="light" />
        </div>
        <div className="mt-6">
          <LiveSurface />
        </div>
      </main>
      {/* Overlap sentinel for the tooltip-anchor spec: a real page always has
          chrome below the console, and a popper that renders inline or picks the
          wrong side would cover it. Kept out of <main> and after all badges so
          it cannot shift any existing snapshot. */}
      <footer
        data-testid="harness-footer"
        className="mx-auto max-w-4xl border-t border-border px-6 py-6 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground"
      >
        Harness footer
      </footer>
    </>
  );
}



