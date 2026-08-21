import { test, expect, type Page } from "@playwright/test";

/**
 * Repeat-focus behaviour for the sync badge tooltip.
 *
 * Two guarantees are enforced here:
 *
 *  1. Escape dismisses the tooltip without removing focus, and tabbing away and
 *     back re-opens it — every time, not just on the first visit. Radix keeps
 *     per-trigger "was dismissed" state, so a regression here silently leaves
 *     keyboard users with a badge that never explains itself again.
 *  2. Focus only ever rests on the Retry button while it is enabled. Retry is
 *     `aria-disabled` (not `disabled`) during a retry so focus is not dumped on
 *     <body>, but nothing may *move* focus onto it while it is inert.
 */

const HARNESS = "/dev/sync-badge";

test.use({ timezoneId: "UTC" });

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
}

/** Tooltips render in a portal, so always query them at the document level. */
const tooltip = (page: Page) => page.getByTestId("radio-sync-tooltip");

function activeTestid(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    return el.getAttribute("data-testid");
  });
}

async function tabTo(page: Page, testid: string, max = 60) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    if ((await activeTestid(page)) === testid) return i;
  }
  throw new Error(`Never reached [data-testid="${testid}"] after ${max} Tab presses`);
}

test.describe("sync badge tooltip re-opens on repeat keyboard focus", () => {
  test("Escape closes, and each new Tab visit re-opens the tooltip", async ({ page }) => {
    await openHarness(page);
    const first = page.getByTestId("badge-dark-synced").getByTestId("radio-sync-status");

    await tabTo(page, "radio-sync-status");
    await expect(first).toBeFocused();
    await expect(tooltip(page).first()).toBeVisible();

    for (let cycle = 0; cycle < 3; cycle++) {
      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
      // Escape must not steal focus — the badge stays the active element.
      await expect(first).toBeFocused();

      // Leave and come back the way a keyboard user would.
      await page.keyboard.press("Tab");
      await expect(first).not.toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(first).toBeFocused();
      await expect(tooltip(page).first()).toBeVisible();
    }
  });

  test("blurring without Escape also re-opens on return", async ({ page }) => {
    await openHarness(page);
    const first = page.getByTestId("badge-dark-synced").getByTestId("radio-sync-status");

    await tabTo(page, "radio-sync-status");
    await expect(tooltip(page).first()).toBeVisible();
    await expect(tooltip(page).first()).toContainText("Mix synced to listener@hybrid-ai-records.com");

    // Tab moves to the next badge; the first badge's tooltip must be gone.
    // (The neighbouring badge's copy starts with the same sentence, so match
    // the first badge's text exactly.)
    await page.keyboard.press("Tab");
    await expect(first).not.toBeFocused();
    await expect(
      tooltip(page).filter({ hasText: /^Mix synced to listener@hybrid-ai-records\.com$/ }),
    ).toHaveCount(0);



    await page.keyboard.press("Shift+Tab");
    await expect(first).toBeFocused();
    await expect(tooltip(page).first()).toBeVisible();
    await expect(tooltip(page).first()).toContainText("Mix synced to listener@hybrid-ai-records.com");

  });
});

test.describe("Retry keeps focus only while it is enabled", () => {
  test("focus stays on Retry across a retry cycle and is never forced onto the inert button", async ({
    page,
  }) => {
    await openHarness(page);
    const live = page.getByTestId("badge-live");
    const retry = live.getByTestId("radio-sync-retry");

    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    await expect(retry).not.toHaveAttribute("aria-disabled", "true");

    // Enter fires Retry; the button flips to aria-disabled but keeps focus so
    // the keyboard user is not dropped back to <body>.
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      (window as unknown as Record<string, (p: unknown) => void>)["__hybridBadgeDrive"]({
        retrying: true,
      });
    });
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await expect(retry).toBeFocused();

    // Tabbing away while it is inert must stick — nothing may pull focus back.
    await page.keyboard.press("Tab");
    await expect(retry).not.toBeFocused();
    await page.waitForTimeout(250);
    await expect(retry).not.toBeFocused();

    // Recovering to a resolved state must not grab focus either.
    await page.evaluate(() => {
      (window as unknown as Record<string, (p: unknown) => void>)["__hybridBadgeDrive"]({
        retrying: false,
        resolveState: { phase: "resolved", tracks: 1 },
      });
    });
    await expect(live.getByTestId("radio-sync-retry")).toHaveCount(0);
    await expect(await activeTestid(page)).not.toBe("radio-sync-retry");
  });

  test("a fresh failure after focus moved away does not steal focus", async ({ page }) => {
    await openHarness(page);
    const live = page.getByTestId("badge-live");

    await live.getByTestId("radio-sync-retry").focus();
    await expect(live.getByTestId("radio-sync-retry")).toBeFocused();

    // Move focus somewhere unrelated, then churn the badge back through error.
    await page.getByTestId("badge-dark-synced").getByTestId("radio-sync-status").focus();
    await page.evaluate(() => {
      (window as unknown as Record<string, (p: unknown) => void>)["__hybridBadgeDrive"]({
        resolveState: { phase: "resolving", tracks: 0 },
      });
    });
    await page.evaluate(() => {
      (window as unknown as Record<string, (p: unknown) => void>)["__hybridBadgeDrive"]({
        resolveState: { phase: "error", tracks: 0, message: "Still failing." },
      });
    });

    await expect(live.getByTestId("radio-sync-retry")).toBeVisible();
    await expect(page.getByTestId("badge-dark-synced").getByTestId("radio-sync-status")).toBeFocused();
  });
});
