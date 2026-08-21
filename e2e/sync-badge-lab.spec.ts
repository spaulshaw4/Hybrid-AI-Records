import { test, expect, type Page } from "@playwright/test";
import { expectBadgeAria, expectRetryAria, expectTooltipAria } from "./helpers/sync-badge-aria";

/**
 * Visual regression across the sync badge lab matrix: theme (light/dark) x
 * reduced motion (on/off) x tooltip (open/closed) x badge phase.
 *
 * The lab at /dev/sync-badge-lab is driven through its real controls, so these
 * runs also prove the harness itself keeps working.
 */

const LAB = "/dev/sync-badge-lab";
const SHOT = { animations: "disabled", maxDiffPixelRatio: 0.01 } as const;

const THEMES = ["dark", "light"] as const;
const MOTIONS = ["no-preference", "reduce"] as const;
/** Phases whose visuals differ meaningfully; tooltip copy differs on all of them. */
const PHASES = ["synced", "resolving", "resolved", "conflict", "error"] as const;

test.use({ timezoneId: "UTC" });

async function openLab(page: Page, motion: (typeof MOTIONS)[number]) {
  await page.emulateMedia({ reducedMotion: motion === "reduce" ? "reduce" : "no-preference" });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(LAB);
  await expect(page.getByRole("heading", { name: "Sync badge lab" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // The readout must agree with the emulated media query, otherwise a snapshot
  // could silently be captured in the wrong motion mode.
  await expect(page.getByTestId("lab-motion-readout")).toHaveAttribute("data-reduced-motion", motion);
}

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  const toggle = page.getByTestId("lab-theme-toggle");
  if ((await page.getByTestId("lab-stage").getAttribute("data-theme")) !== theme) await toggle.click();
  await expect(page.getByTestId("lab-stage")).toHaveAttribute("data-theme", theme);
}

async function setPhase(page: Page, phase: string) {
  await page.getByTestId(`lab-phase-${phase}`).click();
  await expect(page.getByTestId("lab-stage")).toHaveAttribute("data-phase", phase);
}

async function setTooltip(page: Page, open: boolean) {
  const stage = page.getByTestId("lab-stage");
  if ((await stage.getAttribute("data-tooltip")) !== (open ? "open" : "closed")) {
    await page.getByTestId("lab-tooltip-toggle").click();
  }
  await expect(stage).toHaveAttribute("data-tooltip", open ? "open" : "closed");
  if (open) await expect(page.getByTestId("radio-sync-tooltip").first()).toBeVisible();
  else await expect(page.getByTestId("radio-sync-tooltip")).toHaveCount(0);
}

for (const motion of MOTIONS) {
  test.describe(`reduced-motion: ${motion}`, () => {
    for (const theme of THEMES) {
      test(`${theme} theme, tooltip closed, every phase`, async ({ page }) => {
        await openLab(page, motion);
        await setTheme(page, theme);
        await setTooltip(page, false);

        for (const phase of PHASES) {
          await setPhase(page, phase);
          await expect(page.getByTestId("lab-stage")).toHaveScreenshot(
            `lab-${theme}-${motion}-${phase}-closed.png`,
            SHOT,
          );
        }
      });

      test(`${theme} theme, tooltip open, every phase`, async ({ page }) => {
        await openLab(page, motion);
        await setTheme(page, theme);

        for (const phase of PHASES) {
          await setTooltip(page, false);
          await setPhase(page, phase);
          await setTooltip(page, true);
          // The tooltip is portalled outside the stage, so capture the page.
          await expect(page).toHaveScreenshot(`lab-${theme}-${motion}-${phase}-open.png`, SHOT);
        }
      });
    }
  });
}

test("reduced motion swaps the resolving spinner for the static label", async ({ page }) => {
  await openLab(page, "reduce");
  await setPhase(page, "resolving");
  await expect(page.getByTestId("radio-sync-static-progress")).toBeVisible();
  await expect(page.getByTestId("radio-sync-spinner")).toBeHidden();

  await openLab(page, "no-preference");
  await setPhase(page, "resolving");
  await expect(page.getByTestId("radio-sync-spinner")).toBeVisible();
});

test("ARIA contract holds across phases and tooltip states", async ({ page }) => {
  await openLab(page, "no-preference");

  await setPhase(page, "resolved");
  await setTooltip(page, false);
  const stage = page.getByTestId("lab-stage");
  await expectBadgeAria(stage, {
    role: "status",
    name: /^Resolved\./,
    tooltipOpen: false,
  });

  await setTooltip(page, true);
  await expectBadgeAria(stage, { role: "status", name: /^Resolved\./, tooltipOpen: true });
  await expectTooltipAria(page);

  await setTooltip(page, false);
  await setPhase(page, "resolving");
  await expectBadgeAria(stage, { role: "status", busy: true });

  await setPhase(page, "error");
  await expectBadgeAria(stage, { role: "alert", name: /^Sync failed\./ });
  await expectRetryAria(stage);

  await setPhase(page, "error-retrying");
  await expectBadgeAria(stage, { role: "alert", name: /^Sync failed\./ });
  await expectRetryAria(stage, { retrying: true });
});

test("lab controls keep the badge interactive", async ({ page }) => {
  await openLab(page, "no-preference");
  await setPhase(page, "error");
  await page.getByTestId("radio-sync-retry").click();
  await expect(page.getByTestId("lab-retry-count")).toHaveText("Retry fired 1");
});
