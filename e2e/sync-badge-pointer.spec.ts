import { test, expect, type Page } from "@playwright/test";
import { expectBadgeAria, expectRetryAria, expectTooltipAria, waitForHarnessHydrated } from "./helpers/sync-badge-aria";

/**
 * Pointer-driven tooltip behaviour for the sync badge.
 *
 * Keyboard paths are covered in `sync-badge-keyboard.spec.ts`; this suite is
 * about mouse users: the tooltip must open on hover, close when the pointer
 * leaves, close on Escape, close when clicking elsewhere, and never leave a
 * stuck popper or steal/strand keyboard focus in the process.
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;

/** Visible Radix popper only — a closing tooltip lingers in the DOM for a tick. */
const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]:visible");

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await waitForHarnessHydrated(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}


const chip = (page: Page, theme: string, id: string) =>
  page.locator(`[data-testid="badge-${theme}-${id}"] [data-testid="radio-sync-status"]`);

/** What has keyboard focus right now, described the way an AT would see it. */
async function activeTestId(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
  });
}

/** Parks the pointer on the page heading so it cannot land on another badge. */
async function movePointerAway(page: Page, _from?: ReturnType<typeof chip>) {
  await page.getByRole("heading", { name: "Sync badge states" }).hover();
}

/**
 * Hover a trigger and latch on the portalled tooltip — not a one-shot mouse
 * move that Chromium can drop as a pointerleave before React sees it.
 */
async function hoverOpen(page: Page, trigger: ReturnType<typeof chip>, text?: string | RegExp) {
  await trigger.scrollIntoViewIfNeeded();
  const cluster = trigger.locator("xpath=ancestor::*[@data-testid='radio-sync-error-cluster'][1]");
  await expect
    .poll(
      async () => {
        // Real hover (not force): a teleport skips pointerleave on the
        // previous badge and leaves two poppers mounted.
        await trigger.hover();
        const stateEl = (await cluster.count()) > 0 ? cluster : trigger;
        const state = await stateEl.getAttribute("data-state");
        if (!state || !/open/.test(state)) return state ?? "closed";
        if ((await popper(page).count()) < 1) return "open-but-no-popper";
        if (!text) return "ready";
        const body = (await popper(page).textContent()) ?? "";
        const match = typeof text === "string" ? body.includes(text) : text.test(body);
        return match ? "ready" : `wrong-tooltip:${body.slice(0, 80)}`;
      },
      { timeout: 10_000, message: "tooltip never opened on hover" },
    )
    .toBe("ready");
  await expect(page.locator("[data-radix-popper-content-wrapper]").first()).toBeVisible({
    timeout: 3000,
  });
}


for (const theme of THEMES) {
  test.describe(`SyncBadge tooltip — pointer (${theme})`, () => {
    test("hover opens the tooltip without stealing keyboard focus", async ({ page }) => {
      await openHarness(page);
      const trigger = chip(page, theme, "resolved");

      await hoverOpen(page, trigger);
      await expect(popper(page)).toContainText("Kept the most recent play position for 3 tracks");
      await expect(trigger).toHaveAttribute("data-state", /open/);
      // ARIA contract while open: chip keeps role=status + its accessible name,
      // never gains aria-expanded, and the popper stays out of the a11y tree.
      await expectBadgeAria(page.getByTestId(`badge-${theme}-resolved`), {
        role: "status",
        name: /^Resolved\. Kept the most recent play position for 3 tracks\./,
        tooltipOpen: true,
      });
      await expectTooltipAria(page, "Kept the most recent play position for 3 tracks");
      // Hovering must not move focus — a mouse user tabbing later should still
      // start from where they were.
      expect(await activeTestId(page)).toBe("body");
    });

    test("moving the pointer away closes the tooltip", async ({ page }) => {
      await openHarness(page);
      const trigger = chip(page, theme, "resolved");

      await hoverOpen(page, trigger);

      await movePointerAway(page, trigger);
      await expect(trigger).toHaveAttribute("data-state", "closed");
      await expect(popper(page)).toHaveCount(0);
      expect(await activeTestId(page)).toBe("body");
    });

    test("Escape closes a hover-opened tooltip and leaves focus alone", async ({ page }) => {
      await openHarness(page);
      const trigger = chip(page, theme, "resolved");

      await hoverOpen(page, trigger);

      await page.keyboard.press("Escape");
      await expect(popper(page)).toHaveCount(0);
      // Escape dismisses only the tooltip; it must not push focus into the badge.
      expect(await activeTestId(page)).toBe("body");

      // Dismissal is not sticky: leaving and hovering again re-opens it.
      await movePointerAway(page, trigger);
      await hoverOpen(page, trigger);
    });

    test("clicking outside closes the tooltip and strands no focus", async ({ page }) => {
      await openHarness(page);
      const trigger = chip(page, theme, "resolved");

      await hoverOpen(page, trigger);

      await page.getByRole("heading", { name: "Sync badge states" }).click();
      await expect(popper(page)).toHaveCount(0);
      expect(await activeTestId(page)).toBe("body");
    });

    test("clicking the badge itself dismisses the tooltip and focuses the badge", async ({ page }) => {
      await openHarness(page);
      const trigger = chip(page, theme, "synced-aligned");

      await hoverOpen(page, trigger);

      await trigger.click();
      // Radix closes on pointer-down; what matters is no stuck popper and that
      // the badge — which is tabbable — actually holds focus afterwards.
      await expect(popper(page)).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(await activeTestId(page)).toBe("radio-sync-status");
    });

    test("hovering a second badge never leaves two tooltips open", async ({ page }) => {
      await openHarness(page);
      const first = chip(page, theme, "resolved");
      const second = chip(page, theme, "conflict");

      await hoverOpen(page, first, "Kept the most recent play position");

      await hoverOpen(page, second, "A newer change from another device was restored");
      await expect(second).toHaveAttribute("data-state", /open/);
      await expect(first).toHaveAttribute("data-state", "closed");
      await expect(popper(page)).toHaveCount(1);
      await expect(popper(page)).toContainText("A newer change from another device was restored");

    });

    test("mouse-clicking Retry fires it and leaves no stuck tooltip", async ({ page }) => {
      await openHarness(page);
      const scope = page.locator(`[data-testid="badge-${theme}-error"]`);
      const retry = scope.getByRole("button", { name: "Retry timestamp sync" });

      await hoverOpen(page, chip(page, theme, "error"));
      await expect(popper(page)).toContainText("Couldn't compare playback timestamps");

      await retry.click();
      await expect(page.getByTestId(`retry-count-${theme}-error`)).toHaveText("Retry fired 1");
      await expect(scope.getByRole("button", { name: "Retrying timestamp sync" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await expect(popper(page)).toHaveCount(0);

      // Pointer is still over the badge, so hovering it again must work — a
      // stale "dismissed" flag here would silently kill the tooltip.
      await movePointerAway(page, chip(page, theme, "error"));
      await hoverOpen(page, chip(page, theme, "error"));
    });
  });
}
