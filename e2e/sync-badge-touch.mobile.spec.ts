import { test, expect, type Page } from "@playwright/test";

/**
 * Touch behaviour for the sync badge tooltip on phone-sized viewports.
 *
 * Radix deliberately does not open a tooltip on tap (a tap would otherwise
 * fire the trigger and pop a tooltip at the same time), so the contract this
 * suite protects is the absence of touch breakage: tapping must never leave a
 * stuck popper behind, tapping outside must clear any open tooltip, Escape
 * must still dismiss, and Retry must stay tappable with focus in a sane place.
 */

const HARNESS = "/dev/sync-badge";

const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]:visible");

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

const chip = (page: Page, id: string) =>
  page.locator(`[data-testid="badge-dark-${id}"] [data-testid="radio-sync-status"]`);

async function activeTestId(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    return el.getAttribute("data-testid") ?? el.tagName.toLowerCase();
  });
}

test.describe("SyncBadge tooltip — touch", () => {
  test("tapping the badge focuses it and leaves no stuck tooltip", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "resolved");

    await trigger.tap();
    await page.waitForTimeout(400); // past Radix's 150ms open delay

    await expect(popper(page)).toHaveCount(0);
    await expect(trigger).toHaveAttribute("data-state", "closed");
    // The badge is tabbable, so a tap should land focus on it rather than
    // nowhere — that is what lets a switch/VO user continue from here.
    expect(await activeTestId(page)).toBe("radio-sync-status");
  });

  test("double-tapping never stacks tooltips", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "resolved");

    await trigger.tap();
    await trigger.tap();
    await page.waitForTimeout(400);

    expect(await popper(page).count()).toBeLessThanOrEqual(1);
    await expect(trigger).toHaveAttribute("data-state", "closed");
  });

  test("tapping outside clears an open tooltip and releases focus", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "resolved");

    // Open it the way it can be opened on a touch device: via focus.
    await trigger.focus();
    await expect(popper(page)).toHaveCount(1);

    await page.touchscreen.tap(5, 5);
    await expect(popper(page)).toHaveCount(0);
    expect(await activeTestId(page)).toBe("body");
  });

  test("Escape dismisses a focus-opened tooltip on touch devices", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "conflict");

    await trigger.focus();
    await expect(popper(page)).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(popper(page)).toHaveCount(0);
    // Escape must dismiss the tooltip only — focus stays on the badge.
    await expect(trigger).toBeFocused();
  });

  test("tapping Retry fires it without a stuck tooltip", async ({ page }) => {
    await openHarness(page);
    const scope = page.locator('[data-testid="badge-dark-error"]');
    const retry = scope.getByRole("button", { name: "Retry timestamp sync" });

    await retry.tap();

    await expect(page.getByTestId("retry-count-dark-error")).toHaveText("Retry fired 1");
    await expect(scope.getByRole("button", { name: "Retrying timestamp sync" })).toBeDisabled();
    await page.waitForTimeout(400);
    await expect(popper(page)).toHaveCount(0);
  });

  test("a tap anywhere on the badge chip hits the badge, not a neighbour", async ({ page }) => {
    await openHarness(page);
    const trigger = chip(page, "error");
    const box = (await trigger.boundingBox())!;

    // Tap the far left edge of the chip (away from Retry) and confirm the chip
    // itself took the tap — overlapping hit areas would focus the wrong node.
    await page.touchscreen.tap(box.x + 4, box.y + box.height / 2);
    expect(await activeTestId(page)).toBe("radio-sync-status");
    await page.waitForTimeout(400);
    await expect(popper(page)).toHaveCount(0);
  });
});
