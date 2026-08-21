import { expect, test } from "@playwright/test";

const GEAR = '[aria-label="Site settings"]';
const DIALOG = "#site-settings-dialog";

const activeInsideDialog = () =>
  Boolean(document.activeElement?.closest("#site-settings-dialog"));

test.describe("Settings dialog focus trap", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator(GEAR).first().click();
    await page.waitForSelector(DIALOG);
  });

  test("announces itself as a labelled modal dialog", async ({ page }) => {
    const dialog = page.locator(DIALOG);
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", "site-settings-title");
    await expect(dialog).toHaveAttribute("aria-describedby", "site-settings-description");
    await expect(page.locator("#site-settings-title")).toHaveText("Site settings");
    await expect(page.locator(GEAR).first()).toHaveAttribute("aria-expanded", "true");
  });

  test("Tab never leaves the dialog", async ({ page }) => {
    for (let i = 0; i < 45; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(activeInsideDialog), `escaped after ${i + 1} Tab presses`).toBe(
        true,
      );
    }
  });

  test("Shift+Tab never leaves the dialog", async ({ page }) => {
    for (let i = 0; i < 45; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(
        await page.evaluate(activeInsideDialog),
        `escaped after ${i + 1} Shift+Tab presses`,
      ).toBe(true);
    }
  });

  test("Escape closes and returns focus to the gear", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(page.locator(GEAR).first()).toBeFocused();
    await expect(page.locator(GEAR).first()).toHaveAttribute("aria-expanded", "false");
  });
});
