import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SyncBadge, syncTooltipText, type ResolveState } from "@/components/radio/SyncBadge";

/**
 * Accessible tooltip contract for the sync badge.
 *
 * The chip is the trigger: it opens on hover and on keyboard focus, closes on
 * pointer-leave, blur and Escape, and — crucially — never makes a screen
 * reader say the same sentence twice. The visible bubble is decorative
 * (`aria-hidden`); the announcement comes from a stable `aria-describedby`
 * target that exists whether the tooltip is open or not.
 */

const resolved: ResolveState = {
  phase: "resolved",
  tracks: 3,
  winners: [{ device: "Safari on iOS", count: 3, side: "remote" }],
};

const errored: ResolveState = {
  phase: "error",
  tracks: 0,
  message: "Couldn't compare playback timestamps from your other devices.",
};

const base = {
  accountEmail: "artist@hybridairecords.com",
  syncState: "synced" as const,
  conflictNotice: false,
  lastResolvedAt: null,
  retrying: false,
  onRetry: () => {},
};

function renderBadge(resolveState: ResolveState | null = resolved) {
  return render(<SyncBadge {...base} resolveState={resolveState} />);
}

const bubbles = () => screen.queryAllByTestId("radio-sync-tooltip");
const openBubbles = async () => waitFor(() => expect(bubbles().length).toBeGreaterThan(0));
const closedBubbles = async () => waitFor(() => expect(bubbles()).toHaveLength(0));

describe("SyncBadge tooltip — triggers", () => {
  it("opens on keyboard focus and closes on blur", async () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");

    fireEvent.focus(trigger);
    await openBubbles();

    fireEvent.blur(trigger);
    await closedBubbles();
  });

  it("opens on pointer hover and closes when the pointer leaves", async () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    await openBubbles();

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    fireEvent.mouseLeave(trigger);
    await closedBubbles();
  });

  it("dismisses with Escape while focus stays on the trigger", async () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");

    trigger.focus();
    fireEvent.focus(trigger);
    await openBubbles();

    fireEvent.keyDown(document, { key: "Escape" });
    await closedBubbles();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("SyncBadge tooltip — screen-reader announcement", () => {
  it("describes the trigger with the tooltip copy even while closed", () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");
    const describedBy = trigger.getAttribute("aria-describedby")!;
    expect(describedBy).toBeTruthy();

    const target = document.getElementById(describedBy.split(" ")[0]!)!;
    expect(target).toBeTruthy();
    expect(target.textContent).toBe(
      syncTooltipText({
        accountEmail: base.accountEmail,
        resolveState: resolved,
        conflictNotice: false,
        lastResolvedAt: null,
      }),
    );
  });

  it("keeps the description id stable across open and close", async () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");
    const before = trigger.getAttribute("aria-describedby");

    fireEvent.focus(trigger);
    await openBubbles();
    const whileOpen = trigger.getAttribute("aria-describedby");

    fireEvent.blur(trigger);
    await closedBubbles();

    expect(whileOpen).toBe(before);
    expect(trigger.getAttribute("aria-describedby")).toBe(before);
  });

  it("hides the visible bubble from assistive tech so the copy is read once", async () => {
    renderBadge();
    const trigger = screen.getByTestId("radio-sync-status");
    fireEvent.focus(trigger);
    await openBubbles();

    for (const bubble of bubbles()) expect(bubble).toHaveAttribute("aria-hidden", "true");

    const copy = syncTooltipText({
      accountEmail: base.accountEmail,
      resolveState: resolved,
      conflictNotice: false,
      lastResolvedAt: null,
    });
    // Exactly one node in the accessibility tree carries the sentence.
    const announced = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
      (el) =>
        el.textContent?.trim() === copy &&
        !el.closest('[aria-hidden="true"]') &&
        !el.querySelector("*"),
    );
    expect(announced).toHaveLength(1);
  });
});

describe("SyncBadge tooltip — error phase", () => {
  it("opens on focus, dismisses on Escape, and reads the reason once", async () => {
    renderBadge(errored);
    const trigger = screen.getByTestId("radio-sync-status");

    fireEvent.focus(trigger);
    await openBubbles();
    for (const bubble of bubbles()) expect(bubble).toHaveAttribute("aria-hidden", "true");

    const describedBy = trigger.getAttribute("aria-describedby")!;
    const target = document.getElementById(describedBy.split(" ")[0]!)!;
    expect(target.textContent).toContain(errored.message!);
    // Retry points at the same reason, so no second copy is needed.
    expect(screen.getByTestId("radio-sync-retry").getAttribute("aria-describedby")).toBe(describedBy);

    fireEvent.keyDown(document, { key: "Escape" });
    await closedBubbles();
  });

  it("lets the Retry button take focus without closing focus behaviour", async () => {
    renderBadge(errored);
    const retry = screen.getByTestId("radio-sync-retry");
    retry.focus();
    fireEvent.focus(retry);
    await openBubbles();
    expect(document.activeElement).toBe(retry);
  });
});
