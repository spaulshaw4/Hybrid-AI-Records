import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { SyncBadge, type SyncBadgeProps } from "@/components/radio/SyncBadge";

/**
 * These tests approach the badge the way a screen reader does: by role, by
 * accessible name/description, and by walking the focus order with Tab —
 * never by test id or class name.
 */

const base: SyncBadgeProps = {
  accountEmail: "artist@hybridairecords.com",
  syncState: "synced",
  resolveState: null,
  conflictNotice: false,
  lastResolvedAt: null,
  retrying: false,
  onRetry: () => {},
};

/** Renders the badge between two focusable landmarks to observe focus order. */
function renderInPage(props: Partial<SyncBadgeProps> = {}) {
  return render(
    <div>
      <button type="button">Before</button>
      <SyncBadge {...base} {...props} />
      <button type="button">After</button>
    </div>,
  );
}

async function violationsIn(container: HTMLElement) {
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    // jsdom has no layout or paint, so contrast cannot be evaluated here.
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
}

afterEach(() => cleanup());

describe("screen reader announcements (role + name queries)", () => {
  it("exposes a single polite status region whose name is the spoken sentence", () => {
    renderInPage();
    const status = screen.getByRole("status");
    expect(status).toHaveAccessibleName("Mix synced.");
    // Live-region content carries the full sentence, not just the chip shorthand.
    expect(status).toHaveTextContent("Mix synced.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the same live region node across state changes so updates are announced", () => {
    const { rerender } = render(<SyncBadge {...base} syncState="loading" />);
    const first = screen.getByRole("status");
    expect(first).toHaveAccessibleName("Syncing your mix.");

    rerender(<SyncBadge {...base} resolveState={{ phase: "resolving", tracks: 0 }} />);
    expect(screen.getByRole("status")).toBe(first);
    expect(first).toHaveAccessibleName("Resolving playback timestamps across your devices.");

    rerender(
      <SyncBadge {...base} resolveState={{ phase: "resolved", tracks: 2 }} lastResolvedAt={Date.now() - 60_000} />,
    );
    expect(screen.getByRole("status")).toBe(first);
    expect(first).toHaveAccessibleName("Resolved. Kept the most recent play position for 2 tracks. Devices last aligned 1m ago.");
  });

  it("announces a restored remote mix rather than a bare chip label", () => {
    renderInPage({ conflictNotice: true });
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "A newer mix from another device was restored.",
    );
  });

  it("switches to an assertive alert on failure and drops the status role", () => {
    renderInPage({ resolveState: { phase: "error", tracks: 0, message: "Network unreachable" } });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // The retry control's name is part of the alert; assert on the sentence only.
    expect(alert).toHaveTextContent("Sync failed. Network unreachable");
  });

  it("names the retry control by its action, not by its icon", () => {
    const { rerender } = renderInPage({
      resolveState: { phase: "error", tracks: 0, message: "Network unreachable" },
    });
    const retry = screen.getByRole("button", { name: "Retry timestamp sync" });
    expect(retry).toBeEnabled();

    rerender(
      <div>
        <button type="button">Before</button>
        <SyncBadge
          {...base}
          retrying
          resolveState={{ phase: "error", tracks: 0, message: "Network unreachable" }}
        />
        <button type="button">After</button>
      </div>,
    );
    const retrying = screen.getByRole("button", { name: "Retrying timestamp sync" });
    expect(retrying).toHaveAttribute("aria-disabled", "true");
    // Decorative spinner/static markers must not leak into the accessible name.
    expect(retrying).not.toHaveAccessibleName(/⋯/);
  });
});

describe("focus order and keyboard reachability", () => {
  it("places the badge in the natural tab order, before and after page content", async () => {
    const user = userEvent.setup();
    renderInPage();

    await user.tab();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("status")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("reaches the retry button immediately after the alert, with no tab trap", async () => {
    const user = userEvent.setup();
    renderInPage({ resolveState: { phase: "error", tracks: 0, message: "Network unreachable" } });

    await user.tab();
    expect(screen.getByRole("button", { name: "Before" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("alert")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Retry timestamp sync" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("keeps the in-flight retry button focusable but inert", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    renderInPage({
      retrying: true,
      onRetry: () => calls.push("retry"),
      resolveState: { phase: "error", tracks: 0, message: "Network unreachable" },
    });

    await user.tab();
    await user.tab();
    expect(screen.getByRole("alert")).toHaveFocus();
    await user.tab();
    // aria-disabled rather than `disabled`, so focus is never dropped mid-retry.
    const retry = screen.getByRole("button", { name: "Retrying timestamp sync" });
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Enter}");
    expect(calls).toEqual([]);
    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("fires retry from the keyboard with both Enter and Space", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    render(
      <SyncBadge
        {...base}
        onRetry={() => calls.push("retry")}
        resolveState={{ phase: "error", tracks: 0, message: "Network unreachable" }}
      />,
    );
    const retry = screen.getByRole("button", { name: "Retry timestamp sync" });
    retry.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(calls).toEqual(["retry", "retry"]);
  });

  it("does not use positive tabIndex values anywhere in the badge", () => {
    const { container } = renderInPage({ resolveState: { phase: "error", tracks: 0 } });
    const positive = Array.from(container.querySelectorAll("[tabindex]")).filter(
      (el) => Number(el.getAttribute("tabindex")) > 0,
    );
    expect(positive).toHaveLength(0);
  });
});

describe("tooltip exposed as an accessible description", () => {
  it("describes the focused badge with the tooltip copy", async () => {
    const user = userEvent.setup();
    renderInPage({ lastResolvedAt: null });
    const status = screen.getByRole("status");
    // The description target is stable so screen readers never lose it.
    expect(status).toHaveAccessibleDescription(/Mix synced to artist@hybridairecords\.com/);

    await user.tab();
    await user.tab();
    expect(status).toHaveFocus();

    await waitFor(() =>
      expect(status).toHaveAccessibleDescription(/Mix synced to artist@hybridairecords\.com/),
    );
  });

  it("describes the failure alert with the underlying error message", async () => {
    const user = userEvent.setup();
    renderInPage({ resolveState: { phase: "error", tracks: 0, message: "Network unreachable" } });

    await user.tab();
    await user.tab();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveFocus();
    await waitFor(() => expect(alert).toHaveAccessibleDescription(/Network unreachable/));
  });

  it("names the winning device inside the description for a resolved conflict", async () => {
    const user = userEvent.setup();
    renderInPage({
      resolveState: {
        phase: "resolved",
        tracks: 1,
        winners: [{ side: "remote", device: "Chrome on macOS", count: 1 }],
      },
    });

    await user.tab();
    await user.tab();
    const status = screen.getByRole("status");
    await waitFor(() =>
      expect(status).toHaveAccessibleDescription(/Chrome on macOS won 1 track \(on the account\)/),
    );
  });

  it("keeps focus and the description on the badge after Escape", async () => {
    const user = userEvent.setup();
    renderInPage();
    const status = screen.getByRole("status");
    await user.tab();
    await user.tab();
    await waitFor(() => expect(status).toHaveAccessibleDescription(/Mix synced to/));

    await user.keyboard("{Escape}");
    // Escape closes the visual tooltip only — the description stays stable and
    // must not steal focus away from the badge.
    expect(status).toHaveAccessibleDescription(/Mix synced to/);
    expect(status).toHaveFocus();
  });

  it("keeps the tooltip detail out of the badge's accessible name", async () => {
    const user = userEvent.setup();
    renderInPage();
    const status = screen.getByRole("status");
    await user.tab();
    await user.tab();
    await waitFor(() => expect(status).toHaveAccessibleDescription(/Mix synced to/));
    expect(status).toHaveAccessibleName("Mix synced.");
  });
});

describe("axe audit of every badge phase", () => {
  const phases: Array<[string, Partial<SyncBadgeProps>]> = [
    ["synced", {}],
    ["syncing", { syncState: "loading" }],
    ["conflict restored", { conflictNotice: true }],
    ["resolving", { resolveState: { phase: "resolving", tracks: 0 } }],
    ["resolved", { resolveState: { phase: "resolved", tracks: 3 }, lastResolvedAt: Date.now() - 3_600_000 }],
    ["error", { resolveState: { phase: "error", tracks: 0, message: "Network unreachable" } }],
    ["retrying", { retrying: true, resolveState: { phase: "error", tracks: 0, message: "Network unreachable" } }],
  ];

  it.each(phases)("has no violations in the %s phase", async (_name, props) => {
    const { container } = render(<SyncBadge {...base} {...props} />);
    expect(await violationsIn(container)).toEqual([]);
  });
});
