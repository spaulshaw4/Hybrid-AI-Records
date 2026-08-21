import { test, expect, type Page } from "@playwright/test";

/**
 * iOS-style touch coverage for the sync badge tooltip.
 *
 * Companion to sync-badge-touch.mobile.spec.ts, focused on the two gestures an
 * iPhone user actually produces — a quick tap and a long-press (the gesture
 * that on iOS raises the callout / text-selection menu) — and on what those
 * gestures must never do:
 *
 *  - leave a popper stuck on screen after the finger lifts or the page scrolls,
 *  - move focus somewhere unexpected, or strand it on <body>,
 *  - mutate the badge's ARIA contract (role, live region, aria-describedby,
 *    aria-busy / aria-disabled on Retry).
 *
 * Radix intentionally does not open tooltips from touch, so the tooltip is
 * opened through focus where an open state is needed, which is exactly the
 * path VoiceOver's cursor takes on iOS.
 */

const HARNESS = "/dev/sync-badge";

const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]:visible");

const chip = (page: Page, id: string, theme: "dark" | "light" = "dark") =>
  page.locator(`[data-testid="badge-${theme}-${id}"] [data-testid="radio-sync-status"]`);

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

async function activeTestId(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
  });
}

/** Snapshot of the ARIA contract that must survive every touch interaction. */
async function ariaSnapshot(page: Page, testid: string) {
  return page.locator(`[data-testid="${testid}"] [data-testid="radio-sync-status"]`).evaluate((el) => {
    const describedby = (el.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim());
    const retry = el.querySelector("[data-testid='radio-sync-retry']");
    return {
      role: el.getAttribute("role"),
      live: el.getAttribute("aria-live"),
      atomic: el.getAttribute("aria-atomic"),
      name: el.getAttribute("aria-label"),
      busy: el.getAttribute("aria-busy"),
      // The description must resolve to real text, tooltip open or not.
      described: describedby,
      // A tooltip must never add aria-expanded to the trigger — it is not a
      // disclosure, and iOS VoiceOver would announce a bogus "collapsed".
      expanded: el.getAttribute("aria-expanded"),
      retryName: retry?.getAttribute("aria-label") ?? null,
      retryDisabled: retry?.getAttribute("aria-disabled") ?? null,
      retryBusy: retry?.getAttribute("aria-busy") ?? null,
    };
  });
}

/**
 * A real iOS long-press: touchstart, hold past the ~500ms callout threshold
 * with no movement, then touchend at the same point.
 */
async function longPress(page: Page, x: number, y: number, holdMs = 800) {
  await page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px as number, py as number);
      if (!el) throw new Error("no element under long-press point");
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: px as number,
        clientY: py as number,
      });
      el.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          cancelable: true,
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch],
        }),
      );
      (window as unknown as { __lpTarget: Element }).__lpTarget = el;
    },
    [x, y],
  );

  await page.waitForTimeout(holdMs);

  await page.evaluate(
    ([px, py]) => {
      const el = (window as unknown as { __lpTarget: Element }).__lpTarget;
      const touch = new Touch({
        identifier: 1,
        target: el,
        clientX: px as number,
        clientY: py as number,
      });
      el.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [touch],
        }),
      );
    },
    [x, y],
  );
}

/** Centre point of a locator, in viewport coordinates. */
async function centre(page: Page, testid: string, child = "radio-sync-status") {
  const box = (await page.locator(`[data-testid="${testid}"] [data-testid="${child}"]`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("SyncBadge tooltip — iOS tap", () => {
  for (const phase of ["resolved", "conflict", "error"] as const) {
    test(`${phase}: tap keeps the ARIA contract intact and strands no tooltip`, async ({ page }) => {
      await openHarness(page);
      const owner = `badge-dark-${phase}`;
      const before = await ariaSnapshot(page, owner);

      await chip(page, phase).tap();
      await page.waitForTimeout(400); // past Radix's 150ms open delay

      const after = await ariaSnapshot(page, owner);
      expect(after).toEqual(before);
      expect(after.expanded).toBeNull();
      expect(after.described.join(" ").length).toBeGreaterThan(0);
      await expect(popper(page)).toHaveCount(0);
      expect(await activeTestId(page)).toBe("radio-sync-status");
    });
  }

  test("tap then scroll never leaves a detached tooltip floating", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "resolved");

    await trigger.focus();
    await expect(popper(page)).toHaveCount(1);

    // Scrolling with the tooltip open is the classic way to strand a popper.
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);

    const count = await popper(page).count();
    if (count === 1) {
      // Still open: it must stay anchored to its trigger, not float away.
      const tip = (await popper(page).boundingBox())!;
      const box = (await trigger.boundingBox())!;
      expect(Math.abs(tip.x + tip.width / 2 - (box.x + box.width / 2))).toBeLessThan(box.width + 40);
    }
    await expect(trigger).toBeFocused();
  });

  test("tap on one badge moves focus off the previous badge and closes its tooltip", async ({ page }) => {
    await openHarness(page);
    const first = chip(page, "resolved");
    const second = chip(page, "conflict");

    await first.focus();
    await expect(popper(page)).toHaveCount(1);

    await second.tap();
    await page.waitForTimeout(400);

    await expect(second).toBeFocused();
    await expect(first).toHaveAttribute("data-state", "closed");
    // Exactly one tooltip may exist at a time — never one per visited badge.
    expect(await popper(page).count()).toBeLessThanOrEqual(1);
  });
});

test.describe("SyncBadge tooltip — iOS long-press", () => {
  for (const phase of ["resolved", "error"] as const) {
    test(`${phase}: long-press leaves no stuck tooltip and no ARIA drift`, async ({ page }) => {
      await openHarness(page);
      const owner = `badge-dark-${phase}`;
      const before = await ariaSnapshot(page, owner);
      const point = await centre(page, owner);

      await longPress(page, point.x, point.y);
      await page.waitForTimeout(400);

      expect(await ariaSnapshot(page, owner)).toEqual(before);
      await expect(popper(page)).toHaveCount(0);
      await expect(chip(page, phase)).toHaveAttribute("data-state", "closed");
    });
  }

  test("long-press does not select the badge text (no iOS callout)", async ({ page }) => {
    await openHarness(page);
    const point = await centre(page, "badge-dark-resolved");

    await longPress(page, point.x, point.y);

    const selected = await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim());
    expect(selected).toBe("");
  });

  test("long-press on Retry does not fire it, and a tap still does", async ({ page }) => {
    await openHarness(page);
    const owner = "badge-dark-error";
    const scope = page.locator(`[data-testid="${owner}"]`);
    const point = await centre(page, owner, "radio-sync-retry");

    await longPress(page, point.x, point.y);
    await page.waitForTimeout(300);
    // A press without a click must not trigger the action.
    // The harness only renders the counter once a retry fires, so absence == 0.
    await expect(page.getByTestId("retry-count-dark-error")).toHaveCount(0);
    expect((await ariaSnapshot(page, owner)).retryDisabled).toBeNull();

    await scope.getByRole("button", { name: "Retry timestamp sync" }).tap();
    await expect(page.getByTestId("retry-count-dark-error")).toHaveText("Retry fired 1");

    const after = await ariaSnapshot(page, owner);
    expect(after.retryName).toBe("Retrying timestamp sync");
    expect(after.retryDisabled).toBe("true");
    expect(after.retryBusy).toBe("true");
    expect(after.role).toBe("alert");
    expect(after.live).toBe("assertive");
    await page.waitForTimeout(400);
    await expect(popper(page)).toHaveCount(0);
  });

  test("long-press then tap outside restores a clean state with focus released", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "conflict");
    const point = await centre(page, "badge-dark-conflict");

    await longPress(page, point.x, point.y);
    await trigger.focus();
    await expect(popper(page)).toHaveCount(1);

    await page.touchscreen.tap(5, 5);

    await expect(popper(page)).toHaveCount(0);
    await expect(trigger).toHaveAttribute("data-state", "closed");
    expect(await activeTestId(page)).toBe("body");
    // Dismissal must not strip the description wiring the tooltip copy rides on.
    expect((await ariaSnapshot(page, "badge-dark-conflict")).described.join(" ").length).toBeGreaterThan(0);
  });

  test("Escape after a long-press dismisses the tooltip and keeps focus on the badge", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "resolved");
    const point = await centre(page, "badge-dark-resolved");

    await longPress(page, point.x, point.y);
    await trigger.focus();
    await expect(popper(page)).toHaveCount(1);

    await page.keyboard.press("Escape");

    await expect(popper(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await activeTestId(page)).toBe("radio-sync-status");
  });
});
