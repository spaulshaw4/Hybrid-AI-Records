import { test, expect, type Page } from "@playwright/test";
import { expectBadgeAria, expectRetryAria, expectTooltipAria } from "./helpers/sync-badge-aria";

/**
 * Mobile visual regression for the radio sync badge.
 *
 * Mirrors the desktop suite (sync-badge-visual.spec.ts) but runs on the
 * touch-enabled phone profiles and re-sizes to the narrow widths where the
 * badge is most at risk: the chip row can wrap, the Retry button can be pushed
 * out of the pill, and the tooltip has to flip or clamp to stay on screen.
 *
 * Pinned here per width:
 *   - tooltip rendering and placement (opened by focus, the touch-safe path)
 *   - the keyboard focus ring on the badge and on its Retry button
 *   - the reduced-motion swap from spinner to static labels
 *
 * Runs on both mobile-chrome and mobile-safari (iPhone 13 / WebKit), so each
 * check is pinned per engine. The sandbox's WebKit build predates this
 * Playwright release, so `--update-snapshots --project=mobile-safari` can't
 * drive it here; regenerate the `-mobile-safari-linux` baselines with
 * `python3 e2e/tools/gen-safari-snapshots.py`, which replays these exact steps
 * against the runnable WebKit. CI (matching binaries) updates them normally.
 */


const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;

/** Common phone widths: small Android, iPhone SE/13 mini, iPhone 13, Plus/Max. */
const WIDTHS = [320, 360, 390, 430] as const;

const SHOT = { animations: "disabled", maxDiffPixelRatio: 0.01 } as const;

/**
 * Resting (no focus, no tooltip) success and idle phases.
 *   - synced / synced-aligned: idle, nothing in flight
 *   - resolved / conflict: success after a cross-device resolution
 */
const RESTING = [
  { id: "synced", role: "status", name: /^Mix synced\.$/ },
  { id: "synced-aligned", role: "status", name: /^Mix synced\. Devices last aligned/ },
  { id: "resolved", role: "status", name: /^Resolved\. Kept the most recent play position/ },
  { id: "conflict", role: "status", name: /^A newer mix from another device was restored\./ },
] as const;

// A fixed clock and timezone keep the "1m ago" chip and the tooltip's absolute
// timestamp identical on every run.
test.use({ timezoneId: "UTC" });

async function openHarness(page: Page, width: number, pinnedTooltip?: string) {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(pinnedTooltip ? `${HARNESS}?tooltip=${pinnedTooltip}` : HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  // Screenshots must wait for hydration and the dev-server stylesheet:
  // pre-hydration markup has no tooltip behaviour and no motion-reduce rules.
  await page.waitForLoadState("networkidle");
  // Web fonts shift the mono chip labels by a pixel or two if not settled.
  await page.evaluate(() => document.fonts.ready);
}


const badge = (page: Page, theme: string, id: string) => page.getByTestId(`badge-${theme}-${id}`);

test.describe("SyncBadge mobile visual regression", () => {
  for (const width of WIDTHS) {
    test.describe(`${width}px viewport`, () => {
      for (const theme of THEMES) {
        test(`tooltip renders and stays on screen on the ${theme} surface`, async ({ page }) => {
          // Pin the tooltip open from the harness. Focus alone is flaky here:
          // parallel workers share one browser window, so a page that loses
          // window focus blurs the trigger and Radix closes mid-capture.
          await openHarness(page, width, `${theme}:resolved`);

          const trigger = badge(page, theme, "resolved").getByTestId("radio-sync-status");
          // Scroll to a deterministic offset instead of scrollIntoViewIfNeeded so
          // the clip below lands on the same pixels every run.
          await trigger.evaluate((el) => {
            window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 200, behavior: "instant" });
          });


          // Radix also renders a 1px visually-hidden aria copy with role=tooltip,
          // so target the positioned popper for anything visual.
          const tooltip = page.locator("[data-radix-popper-content-wrapper]").first();
          await expect(tooltip).toBeVisible();
          await expect(tooltip).toContainText("Kept the most recent play position for 3 tracks");

          // Semantics travel with the pixels: role, accessible name and the
          // open-state wiring are asserted at every width and theme.
          await expectBadgeAria(badge(page, theme, "resolved"), {
            role: "status",
            name: /^Resolved\. Kept the most recent play position for 3 tracks\./,
            tooltipOpen: true,
          });
          await expectTooltipAria(page, "Kept the most recent play position for 3 tracks");

          // A tooltip clipped by the viewport edge is the classic narrow-width
          // regression, so assert the geometry as well as the pixels.
          const box = (await tooltip.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width + 1);

          // Clip the page to the tooltip: the popper wrapper re-positions itself
          // on every scroll/resize tick, so an element screenshot never settles.
          await expect(page).toHaveScreenshot(`sync-badge-m${width}-tooltip-${theme}.png`, {
            ...SHOT,
            clip: {
              x: Math.max(0, Math.floor(box.x) - 4),
              y: Math.max(0, Math.floor(box.y) - 4),
              width: Math.ceil(box.width) + 8,
              height: Math.ceil(box.height) + 8,
            },
          });
        });


        // Resting (unfocused, no tooltip) success and idle chips. These are what
        // the badge looks like 99% of the time, and they are the states most
        // likely to drift on iOS: WebKit rounds the pill radius, mono letter
        // spacing and the "1m ago" chip differently from Blink.
        test(`success and idle states render consistently on the ${theme} surface`, async ({
          page,
        }) => {
          await openHarness(page, width);

          for (const { id, role, name } of RESTING) {
            const chip = badge(page, theme, id);
            await chip.scrollIntoViewIfNeeded();
            // Nothing may be focused or hovered: a stray focus ring would bake
            // itself into the baseline.
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await expect(chip.getByTestId("radio-sync-status")).toHaveAttribute(
              "data-state",
              "closed",
            );
            await expectBadgeAria(chip, { role, name, tooltipOpen: false });
            await expect(chip).toHaveScreenshot(
              `sync-badge-m${width}-resting-${id}-${theme}.png`,
              SHOT,
            );
          }
        });


        test(`focus rings render consistently on the ${theme} surface`, async ({ page }) => {
          await openHarness(page, width);

          const synced = badge(page, theme, "synced-aligned");
          await synced.scrollIntoViewIfNeeded();
          await synced.getByTestId("radio-sync-status").focus();
          await expectBadgeAria(synced, { role: "status", name: /^Mix synced\./ });
          await expect(synced).toHaveScreenshot(`sync-badge-m${width}-focus-status-${theme}.png`, SHOT);

          const failed = badge(page, theme, "error");
          await failed.scrollIntoViewIfNeeded();
          await failed.getByTestId("radio-sync-retry").focus();
          await expectBadgeAria(failed, {
            role: "alert",
            name: /^Sync failed\. Couldn't compare playback timestamps/,
          });
          await expectRetryAria(failed);
          await expect(failed).toHaveScreenshot(`sync-badge-m${width}-focus-retry-${theme}.png`, SHOT);
        });

        test(`reduced motion shows static labels on the ${theme} surface`, async ({ page }) => {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await openHarness(page, width);

          const resolving = badge(page, theme, "resolving");
          await resolving.scrollIntoViewIfNeeded();
          await expect(resolving.getByTestId("radio-sync-static-progress")).toBeVisible();
          await expect(resolving.getByTestId("radio-sync-spinner")).toBeHidden();
          await expect(resolving).toHaveScreenshot(`sync-badge-m${width}-reduced-resolving-${theme}.png`, SHOT);

          const retrying = badge(page, theme, "error-retrying");
          await retrying.scrollIntoViewIfNeeded();
          await expect(retrying.getByTestId("radio-sync-retry-static")).toBeVisible();
          await expect(retrying.getByTestId("radio-sync-retry-spinner")).toBeHidden();
          await expect(retrying).toHaveScreenshot(`sync-badge-m${width}-reduced-retry-${theme}.png`, SHOT);
        });
      }
    });
  }
});
