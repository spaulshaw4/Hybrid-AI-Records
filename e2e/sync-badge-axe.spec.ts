import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * Browser-level axe-core gate for the sync badge and its Retry button.
 *
 * The jsdom suite (`src/test/sync-badge-axe.test.tsx`) covers markup semantics
 * but cannot score colour, so this suite runs the full rule set — including
 * `color-contrast` — against the real rendered harness at /dev/sync-badge, in
 * both themes, for every badge phase, plus the tooltip-open and Retry-focused
 * states. Any violation fails CI.
 */

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;
const PHASES = [
  "synced",
  "synced-aligned",
  "syncing",
  "resolving",
  "resolved",
  "conflict",
  "error",
  "error-retrying",
] as const;

type Violation = { id: string; impact?: string | null; help: string; nodes: string[] };

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: AXE_PATH });
}

/** Runs axe against one selector subtree and returns a compact violation list. */
async function scan(page: Page, selector: string): Promise<Violation[]> {
  return page.evaluate(async (sel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const results = await axe.run(sel, { resultTypes: ["violations"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: v.nodes.map((n: any) => n.html),
    }));
  }, selector);
}

for (const theme of THEMES) {
  test.describe(`axe-core — ${theme} surface`, () => {
    for (const phase of PHASES) {
      test(`${phase} badge has zero violations`, async ({ page }) => {
        await openHarness(page);
        const selector = `[data-testid="badge-${theme}-${phase}"]`;
        await expect(page.locator(selector)).toBeVisible();
        expect(await scan(page, selector)).toEqual([]);
      });
    }

    test("tooltip content has zero violations when opened", async ({ page }) => {
      await openHarness(page);
      const badge = page.locator(`[data-testid="badge-${theme}-resolved"] [role="status"]`);
      await badge.focus();
      await expect(page.getByTestId("radio-sync-tooltip").first()).toBeVisible();
      // Tooltips portal outside the harness landmark, so scan the portal subtree
      // directly — a portal sitting outside <main> is a harness artifact, not a
      // badge defect.
      expect(await scan(page, "[data-radix-popper-content-wrapper]")).toEqual([]);
    });

    test("Retry button has zero violations while focused and while retrying", async ({ page }) => {
      await openHarness(page);
      const selector = `[data-testid="badge-${theme}-error"]`;
      const retry = page.locator(`${selector} [data-testid="radio-sync-retry"]`);

      await retry.focus();
      await expect(retry).toBeFocused();
      expect(await scan(page, selector)).toEqual([]);

      // Pressing Retry flips the harness badge into its disabled/retrying state.
      await page.keyboard.press("Enter");
      await expect(page.getByTestId(`retry-count-${theme}-error`)).toBeVisible();
      await expect(retry).toBeDisabled();
      expect(await scan(page, selector)).toEqual([]);
    });
  });
}
