import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SyncBadge,
  agoLabel,
  syncAnnouncement,
  syncTooltipText,
  winnersSummary,
} from "@/components/radio/SyncBadge";

const base = {
  accountEmail: "artist@hybridairecords.com",
  syncState: "synced" as const,
  resolveState: null,
  conflictNotice: false,
  lastResolvedAt: null,
  retrying: false,
  onRetry: () => {},
};

afterEach(() => cleanup());

describe("sync badge aria-live announcements", () => {
  it("uses a polite status region for normal states", () => {
    render(<SyncBadge {...base} />);
    const badge = screen.getByTestId("radio-sync-status");
    expect(badge).toHaveAttribute("role", "status");
    expect(badge).toHaveAttribute("aria-live", "polite");
    expect(badge).toHaveAttribute("aria-atomic", "true");
    expect(badge).toHaveTextContent("Mix synced.");
  });

  it("announces the resolving state as a full sentence", () => {
    render(<SyncBadge {...base} resolveState={{ phase: "resolving", tracks: 0 }} />);
    expect(screen.getByTestId("radio-sync-status")).toHaveTextContent(
      "Resolving playback timestamps across your devices.",
    );
  });

  it("announces the resolved track count with correct pluralization", () => {
    const { rerender } = render(<SyncBadge {...base} resolveState={{ phase: "resolved", tracks: 1 }} />);
    expect(screen.getByTestId("radio-sync-status")).toHaveTextContent(
      "Kept the most recent play position for 1 track.",
    );
    rerender(<SyncBadge {...base} resolveState={{ phase: "resolved", tracks: 3 }} />);
    expect(screen.getByTestId("radio-sync-status")).toHaveTextContent(
      "Kept the most recent play position for 3 tracks.",
    );
  });

  it("escalates to an assertive alert on failure", () => {
    render(
      <SyncBadge {...base} resolveState={{ phase: "error", tracks: 0, message: "Network unreachable" }} />,
    );
    const badge = screen.getByTestId("radio-sync-status");
    expect(badge).toHaveAttribute("role", "alert");
    expect(badge).toHaveAttribute("aria-live", "assertive");
    expect(badge).toHaveTextContent("Sync failed. Network unreachable");
    expect(screen.getByTestId("radio-sync-error-cluster")).toHaveAttribute("role", "group");
    expect(screen.getByTestId("radio-sync-error-cluster")).toHaveAttribute("tabindex", "-1");
    expect(badge.contains(screen.getByTestId("radio-sync-retry"))).toBe(false);
    expect(screen.getByTestId("radio-sync-retry")).toHaveAccessibleName("Retry timestamp sync");
  });

  it("appends the last aligned time only when not mid-resolution", () => {
    const at = Date.now() - 120_000;
    expect(
      syncAnnouncement({ syncState: "synced", resolveState: null, conflictNotice: false, lastResolvedAt: at }),
    ).toContain("Devices last aligned 2m ago.");
    expect(
      syncAnnouncement({
        syncState: "synced",
        resolveState: { phase: "resolving", tracks: 0 },
        conflictNotice: false,
        lastResolvedAt: at,
      }),
    ).not.toContain("Devices last aligned");
  });

  it("keeps decorative chips out of the announcement", () => {
    render(<SyncBadge {...base} syncState="loading" />);
    expect(screen.getByTestId("radio-sync-static-progress")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("radio-sync-spinner")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("reduced-motion behavior", () => {
  it("renders a spinner that hides and a static label that shows under prefers-reduced-motion", () => {
    render(<SyncBadge {...base} resolveState={{ phase: "resolving", tracks: 0 }} />);
    const spinner = screen.getByTestId("radio-sync-spinner");
    const staticLabel = screen.getByTestId("radio-sync-static-progress");

    expect(spinner.getAttribute("class")).toContain("animate-spin");
    expect(spinner.getAttribute("class")).toContain("motion-reduce:hidden");

    expect(staticLabel).toHaveTextContent("In Progress");
    expect(staticLabel.getAttribute("class")).toContain("hidden");
    expect(staticLabel.getAttribute("class")).toContain("motion-reduce:inline-block");
  });

  it("shows the busy pair while the account mix is loading", () => {
    render(<SyncBadge {...base} syncState="loading" />);
    expect(screen.getByTestId("radio-sync-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("radio-sync-static-progress")).toBeInTheDocument();
  });

  it("renders no spinner or static progress label when idle", () => {
    render(<SyncBadge {...base} />);
    expect(screen.queryByTestId("radio-sync-spinner")).toBeNull();
    expect(screen.queryByTestId("radio-sync-static-progress")).toBeNull();
  });

  it("swaps the retry spinner for a static marker under reduced motion", () => {
    render(
      <SyncBadge {...base} retrying resolveState={{ phase: "error", tracks: 0, message: "Timed out" }} />,
    );
    expect(screen.getByTestId("radio-sync-retry-spinner").getAttribute("class")).toContain(
      "motion-reduce:hidden",
    );
    const marker = screen.getByTestId("radio-sync-retry-static");
    expect(marker.getAttribute("class")).toContain("motion-reduce:inline");
    // aria-disabled, not `disabled`: keeps the in-flight button focusable.
    expect(screen.getByTestId("radio-sync-retry")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("tooltip content rendering", () => {
  beforeEach(() => {
    // Radix positions tooltips with ResizeObserver, absent in jsdom.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  it("opens the tooltip on keyboard focus and names the synced account", async () => {
    const user = userEvent.setup();
    render(<SyncBadge {...base} />);
    await user.tab();
    expect(screen.getByTestId("radio-sync-status")).toHaveFocus();
    await waitFor(() =>
      expect(screen.getAllByText(/Mix synced to artist@hybridairecords.com/).length).toBeGreaterThan(0),
    );
  });

  it("closes the tooltip on Escape", async () => {
    const user = userEvent.setup();
    render(<SyncBadge {...base} />);
    await user.tab();
    await waitFor(() => expect(screen.queryAllByTestId("radio-sync-tooltip").length).toBeGreaterThan(0));
    await user.keyboard("{Escape}");
    // The visual tooltip closes; the stable sr-only description node stays put
    // (see docs/accessibility/sync-badge-aria-contract.md).
    await waitFor(() => expect(screen.queryAllByTestId("radio-sync-tooltip").length).toBe(0));
    expect(screen.getAllByText(/Mix synced to/).length).toBeGreaterThan(0);
  });

  it("names the winning devices in the tooltip copy", () => {
    const text = syncTooltipText({
      accountEmail: base.accountEmail,
      resolveState: {
        phase: "resolved",
        tracks: 2,
        winners: [
          { device: "Chrome on macOS", count: 1, side: "remote" },
          { device: "this", count: 1, side: "local" },
        ],
      },
      conflictNotice: false,
      lastResolvedAt: null,
    });
    expect(text).toContain("Kept the most recent play position for 2 tracks");
    expect(text).toContain("Chrome on macOS won 1 track (on the account)");
    expect(text).toContain("This device won 1 track (locally)");
  });

  it("includes the absolute and relative last-aligned time", () => {
    const at = Date.now() - 3_600_000;
    const text = syncTooltipText({
      accountEmail: base.accountEmail,
      resolveState: null,
      conflictNotice: false,
      lastResolvedAt: at,
    });
    expect(text).toContain("Devices last aligned 1h ago");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  });

  it("explains a restored conflict instead of the account email", () => {
    expect(
      syncTooltipText({
        accountEmail: base.accountEmail,
        resolveState: null,
        conflictNotice: true,
        lastResolvedAt: null,
      }),
    ).toBe("A newer change from another device was restored");
  });

  it("surfaces the error message in the failure tooltip", async () => {
    const user = userEvent.setup();
    render(<SyncBadge {...base} resolveState={{ phase: "error", tracks: 0, message: "Network unreachable" }} />);
    await user.tab();
    await waitFor(() =>
      expect(screen.getAllByText("Network unreachable").length).toBeGreaterThan(0),
    );
  });

  it("fires the retry handler from the keyboard", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<SyncBadge {...base} onRetry={onRetry} resolveState={{ phase: "error", tracks: 0 }} />);
    screen.getByTestId("radio-sync-retry").focus();
    await user.keyboard("{Enter}");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("label helpers", () => {
  it("formats relative times compactly", () => {
    const now = Date.now();
    expect(agoLabel(now - 5_000)).toBe("5s ago");
    expect(agoLabel(now - 300_000)).toBe("5m ago");
    expect(agoLabel(now - 7_200_000)).toBe("2h ago");
    expect(agoLabel(now - 172_800_000)).toBe("2d ago");
    expect(agoLabel(now + 10_000)).toBe("0s ago");
  });

  it("returns an empty winners summary when nothing was reconciled", () => {
    expect(winnersSummary()).toBe("");
    expect(winnersSummary([])).toBe("");
  });
});
