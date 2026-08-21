import { test, expect, type Page } from "@playwright/test";
import { expectBadgeAria, expectRetryAria, expectTooltipAria } from "./helpers/sync-badge-aria";

/**
 * Visual regression for the radio sync badge.
 *
 * Captured from the internal harness at /dev/sync-badge, which renders every
 * badge state on a dark and a light surface with a frozen "last aligned"
 * timestamp, so the only thing that can move a snapshot is a real styling
 * change. Three things are pinned here:
 *   - tooltip rendering (opened by keyboard, the accessible path)
 *   - the keyboard focus ring on the badge and its Retry button
 *   - the reduced-motion swap from spinner to static "In Progress" label
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;

/** Screenshot options shared by every assertion in this file. */
const SHOT = { animations: "disabled", maxDiffPixelRatio: 0.01 } as const;

// A fixed clock and timezone keep the badge's "1m ago" chip and the absolute
// timestamp inside the tooltip identical on every run.
test.use({ timezoneId: "UTC" });

async function openHarness(page: Page) {
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  // Screenshots must wait for hydration and for the dev-server stylesheet:
  // pre-hydration markup has no tooltip behaviour and no motion-reduce rules.
  await page.waitForLoadState("networkidle");
  // Web fonts shift the mono chip labels by a pixel or two if not settled.
  await page.evaluate(() => document.fonts.ready);
}

const badge = (page: Page, theme: string, id: string) => page.getByTestId(`badge-${theme}-${id}`);

test.describe("SyncBadge visual regression", () => {
  for (const theme of THEMES) {
    test(`resting badge states render consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await expect(page.getByTestId(`badge-surface-${theme}`)).toHaveScreenshot(
        `sync-badge-states-${theme}.png`,
        SHOT,
      );
    });

    test(`tooltip content renders consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      // Keyboard focus is the accessible way to open the tooltip, and it also
      // captures the focus ring and tooltip together.
      await badge(page, theme, "resolved").getByTestId("radio-sync-status").focus();
      await expectBadgeAria(badge(page, theme, "resolved"), {
        role: "status",
        name: /^Resolved\. Kept the most recent play position for 3 tracks\./,
        tooltipOpen: true,
      });
      await expectTooltipAria(page, "Kept the most recent play position for 3 tracks");
      const tooltip = page.getByTestId("radio-sync-tooltip").first();
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("Kept the most recent play position for 3 tracks");
      await expect(page).toHaveScreenshot(`sync-badge-tooltip-${theme}.png`, SHOT);
    });

    test(`focus rings render consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);

      const synced = badge(page, theme, "synced-aligned");
      await synced.getByTestId("radio-sync-status").focus();
      await expectBadgeAria(synced, { role: "status", name: /^Mix synced\./ });
      await expect(synced).toHaveScreenshot(`sync-badge-focus-status-${theme}.png`, SHOT);

      const failed = badge(page, theme, "error");
      await failed.getByTestId("radio-sync-retry").focus();
      await expectBadgeAria(failed, {
        role: "alert",
        name: /^Sync failed\. Couldn't compare playback timestamps/,
      });
      await expectRetryAria(failed);
      await expect(failed).toHaveScreenshot(`sync-badge-focus-retry-${theme}.png`, SHOT);
    });
  }

  test.describe("reduced motion", () => {
    for (const theme of THEMES) {
      test(`static progress label replaces the spinner on the ${theme} surface`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await openHarness(page);

        const resolving = badge(page, theme, "resolving");
        await expect(resolving.getByTestId("radio-sync-static-progress")).toBeVisible();
        await expect(resolving.getByTestId("radio-sync-spinner")).toBeHidden();
        await expect(resolving).toHaveScreenshot(`sync-badge-reduced-resolving-${theme}.png`, SHOT);

        const retrying = badge(page, theme, "error-retrying");
        await expect(retrying.getByTestId("radio-sync-retry-static")).toBeVisible();
        await expect(retrying.getByTestId("radio-sync-retry-spinner")).toBeHidden();
        await expect(retrying).toHaveScreenshot(`sync-badge-reduced-retry-${theme}.png`, SHOT);
      });
    }
  });

  test.describe("motion allowed", () => {
    test("the spinner is shown instead of the static label", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openHarness(page);
      const resolving = badge(page, "dark", "resolving");
      await expect(resolving.getByTestId("radio-sync-spinner")).toBeVisible();
      await expect(resolving.getByTestId("radio-sync-static-progress")).toBeHidden();
      await expect(resolving).toHaveScreenshot("sync-badge-motion-resolving-dark.png", SHOT);
    });
  });
});
