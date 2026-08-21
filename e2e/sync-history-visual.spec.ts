import { test, expect, type Page } from "@playwright/test";

/**
 * Visual regression for the radio Sync History panel.
 *
 * Captured from the internal harness at /dev/sync-history, which renders the
 * panel's four states — empty, local activity only, cross-device resolutions,
 * and a failed resolution with its Retry flow — on a dark and a light surface
 * with frozen timestamps. Covered here:
 *   - each resting state per theme
 *   - the conflict-resolution block (winning device + resolved timestamp)
 *   - the Sync Failed block and the keyboard focus ring on its Retry button
 */

const HARNESS = "/dev/sync-history";
const THEMES = ["dark", "light"] as const;

const SHOT = { animations: "disabled", maxDiffPixelRatio: 0.002 } as const;

// Fixed clock + timezone keep the "3m ago" chips and title tooltips stable.
test.use({ timezoneId: "UTC" });

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync History States" })).toBeVisible();
  // Snapshots must wait for hydration and the dev-server stylesheet.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

const panel = (page: Page, theme: string, id: string) => page.getByTestId(`history-${theme}-${id}`);

test.describe("Sync History visual regression", () => {
  for (const theme of THEMES) {
    test(`all panel states render consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await expect(page.getByTestId(`history-surface-${theme}`)).toHaveScreenshot(
        `sync-history-states-${theme}.png`,
        SHOT,
      );
    });

    test(`conflict resolution entries render consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      const resolved = panel(page, theme, "resolved");
      const list = resolved.getByTestId("radio-resolutions");
      await expect(list).toBeVisible();
      // The two sides of a conflict: the remote device that won, and a track
      // this device won outright.
      await expect(list).toContainText("Safari on iOS");
      await expect(list).toContainText("This device");
      await expect(resolved).toHaveScreenshot(`sync-history-resolved-${theme}.png`, SHOT);
    });

    test(`failed resolution block renders consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      const failed = panel(page, theme, "failed");
      const failures = failed.getByTestId("radio-sync-failures");
      await expect(failures).toBeVisible();
      // Newest failure first.
      await expect(failures.locator("li").first()).toContainText("Couldn't reach your account");
      await expect(failed).toHaveScreenshot(`sync-history-failed-${theme}.png`, SHOT);
    });

    test(`Retry focus ring renders consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      const failed = panel(page, theme, "failed");
      await failed.getByTestId("radio-history-retry").focus();
      await expect(failed.getByTestId("radio-sync-failures")).toHaveScreenshot(
        `sync-history-retry-focus-${theme}.png`,
        SHOT,
      );
    });

    test(`Retry stays operable from the keyboard on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      const failed = panel(page, theme, "failed");
      await failed.getByTestId("radio-history-retry").focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId(`retry-count-${theme}-failed`)).toHaveText("Retry fired 1");
    });

    test(`empty state renders consistently on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      const empty = panel(page, theme, "empty");
      await expect(empty).toContainText("No cross-device resolutions yet.");
      await expect(empty).toHaveScreenshot(`sync-history-empty-${theme}.png`, SHOT);
    });
  }
});
