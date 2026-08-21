import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * iOS Safari a11y audit for the sync badge tooltip.
 *
 * `e2e/sync-badge-axe.spec.ts` runs the same rule set on desktop Chromium.
 * This file is the phone-profile pass — the `mobile-safari` project runs every
 * `*.mobile.spec.ts`, so it audits real WebKit, where the tooltip's
 * description wiring matters most: VoiceOver reads the chip's
 * `aria-describedby` target, never the portalled Radix tooltip (which is
 * `aria-hidden` on purpose to avoid a doubled announcement).
 *
 * Alongside axe it asserts the semantics axe cannot know are intentional:
 *   - the chip exposes role status/alert with an accessible name
 *   - `aria-describedby` resolves to a real, non-empty, in-document node
 *   - the visible tooltip stays out of the accessibility tree
 *   - the tooltip trigger carries no `aria-expanded` (per the ARIA APG)
 *
 * Sandbox note: the image's WebKit predates this @playwright/test protocol, so
 * `--project=mobile-safari` can't launch locally. `python3
 * e2e/tools/verify-safari-axe.py` replays these checks on the runnable WebKit.
 */

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;
/** Phases whose tooltip copy differs enough to be worth a separate audit. */
const PHASES = ["synced", "resolving", "resolved", "conflict", "error", "error-retrying"] as const;

type Violation = { id: string; impact?: string | null; help: string; nodes: string[] };

async function openHarness(page: Page) {
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: AXE_PATH });
}

/** Runs axe over one subtree and returns a compact violation list. */
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

/** Resolve the chip's ARIA contract the way an AT would read it. */
async function describeChip(page: Page, badgeSelector: string) {
  return page.evaluate((sel) => {
    const chip = document.querySelector(`${sel} [data-testid="radio-sync-status"]`);
    if (!chip) return null;
    const ids = (chip.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return {
      role: chip.getAttribute("role"),
      name: chip.getAttribute("aria-label") ?? "",
      live: chip.getAttribute("aria-live"),
      expanded: chip.getAttribute("aria-expanded"),
      describedby: ids,
      // Text an AT would announce from each described-by target.
      descriptions: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? null),
    };
  }, badgeSelector);
}

for (const theme of THEMES) {
  test.describe(`iOS a11y audit — ${theme} surface`, () => {
    for (const phase of PHASES) {
      test(`${phase}: badge + open tooltip pass axe and expose the right descriptions`, async ({
        page,
      }) => {
        await openHarness(page);
        const badgeSelector = `[data-testid="badge-${theme}-${phase}"]`;
        const badge = page.locator(badgeSelector);
        await badge.scrollIntoViewIfNeeded();
        await expect(badge).toBeVisible();

        // 1. Resting badge: full rule set, including colour contrast at phone size.
        expect(await scan(page, badgeSelector), `resting ${phase}`).toEqual([]);

        // 2. ARIA contract of the chip itself.
        const chip = await describeChip(page, badgeSelector);
        expect(chip, "chip must exist").not.toBeNull();
        expect(chip!.role === "status" || chip!.role === "alert").toBe(true);
        expect(chip!.name.length).toBeGreaterThan(0);
        // A tooltip trigger must NOT claim aria-expanded (ARIA APG tooltip pattern).
        expect(chip!.expanded).toBeNull();
        // Every described-by id must resolve to real, non-empty text — a dangling
        // id silently drops the description on VoiceOver.
        expect(chip!.describedby.length).toBeGreaterThan(0);
        for (const text of chip!.descriptions) {
          expect(text, `dangling aria-describedby on ${phase}`).toBeTruthy();
          expect((text ?? "").length).toBeGreaterThan(0);
        }

        // 3. Open the tooltip and audit the portalled content.
        await badge.getByTestId("radio-sync-status").focus();
        const popper = page.locator("[data-radix-popper-content-wrapper]:visible");
        await expect(popper).toHaveCount(1);
        expect(await scan(page, "[data-radix-popper-content-wrapper]"), `tooltip ${phase}`).toEqual(
          [],
        );

        // 4. The visible tooltip is decorative: its text is already announced via
        // aria-describedby, so it must stay out of the accessibility tree.
        const tooltip = page.getByTestId("radio-sync-tooltip").first();
        await expect(tooltip).toHaveAttribute("aria-hidden", "true");
        // ...and it must still carry the copy a sighted user sees.
        expect(((await tooltip.innerText()) ?? "").trim().length).toBeGreaterThan(0);

        // 5. The chip's contract is unchanged by opening the tooltip.
        expect(await describeChip(page, badgeSelector)).toEqual(chip);
      });
    }

    test("Retry keeps an accessible name and description while retrying", async ({ page }) => {
      await openHarness(page);
      const badgeSelector = `[data-testid="badge-${theme}-error"]`;
      const badge = page.locator(badgeSelector);
      await badge.scrollIntoViewIfNeeded();

      const retry = badge.getByTestId("radio-sync-retry");
      await retry.focus();
      expect(await scan(page, badgeSelector), "focused Retry").toEqual([]);

      const named = await retry.evaluate((el) => ({
        name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim(),
        describedby: el.getAttribute("aria-describedby"),
        // aria-disabled, never `disabled`: a real disabled attr drops it from the
        // a11y tree mid-retry and VoiceOver loses the element.
        ariaDisabled: el.getAttribute("aria-disabled"),
        disabled: el.hasAttribute("disabled"),
      }));
      expect(named.name.length).toBeGreaterThan(0);
      expect(named.describedby).toBeTruthy();
      expect(named.disabled).toBe(false);

      await page.keyboard.press("Enter");
      await expect(page.getByTestId(`retry-count-${theme}-error`)).toBeVisible();
      // Audit again mid-retry: the busy state must not introduce violations.
      expect(await scan(page, badgeSelector), "retrying").toEqual([]);
      expect(await retry.evaluate((el) => el.hasAttribute("disabled"))).toBe(false);
    });
  });
}
