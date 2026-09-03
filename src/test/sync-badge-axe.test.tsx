import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { SyncBadge, type ResolveState, type SyncBadgeProps } from "@/components/radio/SyncBadge";

/**
 * axe-core gate for the radio sync badge and its Retry control.
 *
 * Every badge phase is rendered and scanned for zero violations. Contrast is
 * disabled here because jsdom has no layout or paint — the real colour scoring
 * lives in the browser suites (`e2e/sync-badge-axe.spec.ts` and
 * `e2e/sync-badge-contrast.spec.ts`).
 */

async function violationsIn(container: HTMLElement) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => n.html) }));
}

const LAST_RESOLVED = Date.now() - 61_000;

type Phase = { id: string; props: Omit<SyncBadgeProps, "accountEmail" | "onRetry"> };

const resolving: ResolveState = {
  phase: "resolving",
  tracks: 2,
  winners: [{ device: "Safari on iOS", count: 2, side: "remote" }],
};

const resolved: ResolveState = {
  phase: "resolved",
  tracks: 3,
  winners: [
    { device: "Safari on iOS", count: 2, side: "remote" },
    { device: "Chrome on macOS", count: 1, side: "local" },
  ],
};

const errored: ResolveState = {
  phase: "error",
  tracks: 0,
  message: "Couldn't compare playback timestamps from your other devices.",
};

const base = { conflictNotice: false, lastResolvedAt: LAST_RESOLVED, retrying: false } as const;

const PHASES: Phase[] = [
  { id: "idle", props: { ...base, syncState: "idle", resolveState: null, lastResolvedAt: null } },
  { id: "loading", props: { ...base, syncState: "loading", resolveState: null, lastResolvedAt: null } },
  { id: "synced", props: { ...base, syncState: "synced", resolveState: null, lastResolvedAt: null } },
  { id: "synced-aligned", props: { ...base, syncState: "synced", resolveState: null } },
  { id: "resolving", props: { ...base, syncState: "synced", resolveState: resolving } },
  { id: "resolved", props: { ...base, syncState: "synced", resolveState: resolved } },
  { id: "conflict", props: { ...base, syncState: "synced", resolveState: null, conflictNotice: true } },
  { id: "error", props: { ...base, syncState: "synced", resolveState: errored } },
  { id: "error-retrying", props: { ...base, syncState: "synced", resolveState: errored, retrying: true } },
];

function renderPhase(phase: Phase) {
  return render(
    <SyncBadge accountEmail="listener@hybrid-ai-records.com" onRetry={() => {}} {...phase.props} />,
  );
}

describe("axe-core: radio sync badge phases", () => {
  it.each(PHASES.map((p) => [p.id, p] as const))("has zero violations in the %s phase", async (_id, phase) => {
    const { container } = renderPhase(phase);
    expect(await violationsIn(container)).toEqual([]);
  });

  it("keeps the Retry control accessible while idle and while retrying", async () => {
    const { rerender, container } = render(
      <SyncBadge
        accountEmail="listener@hybrid-ai-records.com"
        onRetry={() => {}}
        {...PHASES.find((p) => p.id === "error")!.props}
      />,
    );

    const retry = screen.getByTestId("radio-sync-retry");
    expect(retry).toHaveAccessibleName("Retry timestamp sync");
    expect(retry).not.toBeDisabled();
    expect(retry).not.toHaveAttribute("aria-live", /.*/);
    expect(screen.getByRole("alert").contains(retry)).toBe(false);
    expect(await violationsIn(container)).toEqual([]);

    rerender(
      <SyncBadge
        accountEmail="listener@hybrid-ai-records.com"
        onRetry={() => {}}
        {...PHASES.find((p) => p.id === "error-retrying")!.props}
      />,
    );

    const retrying = screen.getByTestId("radio-sync-retry");
    expect(retrying).toHaveAccessibleName("Retrying timestamp sync");
    expect(retrying).toHaveAttribute("aria-disabled", "true");
    expect(retrying).toHaveAttribute("aria-live", "assertive");
    expect(retrying).toHaveAttribute("aria-atomic", "true");
    expect(await violationsIn(container)).toEqual([]);
  });

  it("announces the failure through an assertive alert", async () => {
    renderPhase(PHASES.find((p) => p.id === "error")!);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert.getAttribute("aria-label")).toContain("Sync failed");
  });

  it("has zero violations with the tooltip open", async () => {
    const { container, baseElement } = renderPhase(PHASES.find((p) => p.id === "resolved")!);
    const trigger = screen.getByRole("status");

    fireEvent.focus(trigger);
    await waitFor(() => expect(screen.getAllByTestId("radio-sync-tooltip").length).toBeGreaterThan(0));

    expect(await violationsIn(container)).toEqual([]);
    expect(await violationsIn(baseElement as HTMLElement)).toEqual([]);
  });
});
