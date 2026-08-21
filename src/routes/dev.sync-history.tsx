import { useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { devOnlyBeforeLoad } from "@/lib/dev-route-guard";
import { createFileRoute } from "@tanstack/react-router";
import {
  SyncHistoryPanel,
  type HistoryGroup,
  type Resolution,
  type SyncFailure,
} from "@/components/radio/SyncHistoryPanel";

/**
 * Visual-regression harness for the radio Sync History panel.
 *
 * The panel normally only appears for a signed-in listener after real
 * cross-device activity, so its conflict-resolution states are hard to capture
 * deterministically. This page renders each state with frozen timestamps on
 * both a dark and a light surface. Excluded from search engines; no product
 * content.
 */

export const Route = createFileRoute("/dev/sync-history")({
  beforeLoad: devOnlyBeforeLoad,
  head: () =>
    pageHead({
      path: "/dev/sync-history",
      title: "Sync History States — Hybrid AI Records Internal",
      description: "Internal rendering harness for the Hybrid AI Radio sync history panel: resolved timestamps, conflicts and failure states.",
      socialTitle: "Sync History States — Hybrid AI Records Internal",
      socialDescription: "Internal rendering harness for the Hybrid AI Radio sync history panel states.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: SyncHistoryHarness,
});

/** Frozen offsets keep the "3m ago" style labels stable between runs. */
const NOW = Date.now();
const ago = (mins: number) => NOW - mins * 60_000;

const RESOLUTIONS: Resolution[] = [
  {
    key: "stacey-la-bradbury/burn-the-blueprint",
    title: "Burn The Blueprint",
    artist: "Stacey LA Bradbury",
    seconds: 94.4,
    at: ago(3),
    wonAt: ago(3),
    device: "Safari on iOS",
    side: "remote",
  },
  {
    key: "the-jester-ai/what-i-told-the-fire-at-3am",
    title: "What I Told The Fire At 3am",
    artist: "The Jester AI",
    seconds: 187,
    at: ago(12),
    device: "This device",
    side: "local",
  },
];

const GROUPS: HistoryGroup[] = [
  {
    key: "stacey-la-bradbury/burn-the-blueprint",
    title: "Burn The Blueprint",
    artist: "Stacey LA Bradbury",
    saved: 94.4,
    events: [
      { key: "a", kind: "resolved", seconds: 94.4, at: ago(3), wonAt: ago(3), device: "Safari on iOS", winner: "remote" },
      { key: "a", kind: "seek", seconds: 61, at: ago(5) },
      { key: "a", kind: "play", seconds: 0, at: ago(9) },
    ],
  },
  {
    key: "the-jester-ai/what-i-told-the-fire-at-3am",
    title: "What I Told The Fire At 3am",
    artist: "The Jester AI",
    saved: 187,
    events: [
      { key: "b", kind: "resolved", seconds: 187, at: ago(12), winner: "local" },
      { key: "b", kind: "pause", seconds: 187, at: ago(13) },
      { key: "b", kind: "resume", seconds: 120.5, at: ago(20) },
    ],
  },
];

const FAILURES: SyncFailure[] = [
  { at: ago(1), message: "Couldn't reach your account to resolve playback timestamps." },
  { at: ago(6), message: "Sync request timed out while comparing seek positions." },
];

type Case = {
  id: string;
  label: string;
  failures: SyncFailure[];
  resolutions: Resolution[];
  groups: HistoryGroup[];
};

const CASES: Case[] = [
  { id: "empty", label: "No activity yet", failures: [], resolutions: [], groups: [] },
  { id: "history-only", label: "Local activity, no conflicts", failures: [], resolutions: [], groups: GROUPS },
  {
    id: "resolved",
    label: "Cross-device resolutions",
    failures: [],
    resolutions: RESOLUTIONS,
    groups: GROUPS,
  },
  {
    id: "failed",
    label: "Resolution failed with retry",
    failures: FAILURES,
    resolutions: RESOLUTIONS,
    groups: GROUPS,
  },
];

function Surface({ theme }: { theme: "dark" | "light" }) {
  // Retry/Clear are inert here, but a press counter proves the controls fire
  // without disturbing the resting snapshots.
  const [presses, setPresses] = useState<Record<string, number>>({});

  return (
    <section
      data-testid={`history-surface-${theme}`}
      className={`${theme === "light" ? "theme-light " : ""}rounded-lg border border-border bg-background p-6`}
    >
      <h2 className="mb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
        {theme} surface
      </h2>
      <ul className="space-y-8">
        {CASES.map((c) => (
          <li key={c.id} className="flex flex-col gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">{c.label}</span>
            <div data-testid={`history-${theme}-${c.id}`} className="max-w-xl p-1">
              <SyncHistoryPanel
                failures={c.failures}
                resolutions={c.resolutions}
                groups={c.groups}
                hasHistory={c.groups.length > 0}
                onRetry={() => setPresses((p) => ({ ...p, [`${c.id}-retry`]: (p[`${c.id}-retry`] ?? 0) + 1 }))}
                onClear={() => setPresses((p) => ({ ...p, [`${c.id}-clear`]: (p[`${c.id}-clear`] ?? 0) + 1 }))}
              />
            </div>
            {presses[`${c.id}-retry`] ? (
              <span
                data-testid={`retry-count-${theme}-${c.id}`}
                className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
              >
                {`Retry fired ${presses[`${c.id}-retry`]}`}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SyncHistoryHarness() {
  return (
    <main className="min-h-dvh bg-background p-8">
      <h1 className="mb-6 font-mono text-xs uppercase tracking-[0.3em] text-primary">Sync History States</h1>
      <div className="grid gap-8 lg:grid-cols-2">
        <Surface theme="dark" />
        <Surface theme="light" />
      </div>
    </main>
  );
}
