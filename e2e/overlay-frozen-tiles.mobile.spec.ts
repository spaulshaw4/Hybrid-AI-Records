import { test, expect } from "@playwright/test";
import { cycleTrigger, expectNoFrozenTiles, expectOverlayStateClean, measureTiles } from "./helpers/overlay-cycle";

/**
 * iOS Safari / WebKit stress: repeatedly open and close every modal, dropdown
 * and style-selection menu on the main routes and prove the compositor never
 * leaves a frozen (flat, unrepainted) tile behind.
 *
 * Runs on the touch phone profiles (mobile-safari when the image's WebKit is
 * usable, mobile-chrome always) via the `.mobile.spec.ts` naming convention.
 */

const ROUTES = ["/", "/portal", "/engine", "/artists", "/tokens"] as const;
const CYCLES = 3;

// Screenshot decoding per assertion makes this suite slow but deterministic.
test.describe.configure({ timeout: 180_000 });

for (const route of ROUTES) {
  test(`overlays survive repeated open/close on ${route}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    await expectNoFrozenTiles(page, `${route} initial`);

    const triggerCount = await page
      .locator(
        "[aria-haspopup='dialog']:visible, [aria-haspopup='menu']:visible, [aria-haspopup='listbox']:visible, button[role='combobox']:visible",
      )
      .count();

    for (let pass = 0; pass < CYCLES; pass++) {
      for (let i = 0; i < Math.min(triggerCount, 8); i++) {
        await cycleTrigger(page, i, `${route} trigger#${i} pass${pass}`);
        await expectOverlayStateClean(page, `${route} trigger#${i} pass${pass}`);
      }
    }

    // Page must still be interactive and painting after the stress loop.
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(200);
    await expectNoFrozenTiles(page, `${route} after stress`);

    const fatal = consoleErrors.filter((e) => /removeChild|not a function|undefined is not an object|Maximum update depth/i.test(e));
    expect(fatal, `${route}: fatal render errors during overlay stress`).toEqual([]);
  });
}

test("style selection menu repaints after rapid selection churn", async ({ page }) => {
  await page.goto("/engine", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);

  const combos = page.locator("button[role='combobox']:visible");
  const count = await combos.count();
  test.skip(count === 0, "no style selection menus rendered on /engine for this session");

  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < Math.min(count, 4); i++) {
      const combo = combos.nth(i);
      await combo.scrollIntoViewIfNeeded().catch(() => {});
      await combo.click({ timeout: 5_000 }).catch(() => {});
      const listbox = page.locator("[role='listbox']:visible").first();
      if (await listbox.isVisible().catch(() => false)) {
        const options = listbox.locator("[role='option']");
        const optionCount = await options.count();
        if (optionCount > 0) {
          await options.nth(pass % optionCount).click({ timeout: 4_000 }).catch(() => {});
        } else {
          await page.keyboard.press("Escape");
        }
        await listbox.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(120);
      await expectNoFrozenTiles(page, `style menu #${i} pass${pass}`);

      // Some selections intentionally open a follow-up dialog; dismiss any
      // remaining overlay before asserting the closed-state invariants.
      for (let escapes = 0; escapes < 3; escapes++) {
        const stillOpen = await page.locator("[role='dialog']:visible, [role='listbox']:visible, [role='menu']:visible").count();
        if (!stillOpen) break;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
      await expectOverlayStateClean(page, `style menu #${i} pass${pass}`);

    }
  }

  const final = await measureTiles(page);
  expect(final.flatTiles, "style menu churn left frozen tiles").toBeLessThanOrEqual(8);
});

test("safe mode overlays also repaint cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    document.documentElement.setAttribute("data-safe-mode", "on");
  });
  await page.goto("/portal", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);

  const triggerCount = await page
    .locator("[aria-haspopup='dialog']:visible, button[role='combobox']:visible")
    .count();

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < Math.min(triggerCount, 6); i++) {
      await cycleTrigger(page, i, `safe-mode trigger#${i} pass${pass}`);
      await expectOverlayStateClean(page, `safe-mode trigger#${i} pass${pass}`);
    }
  }
});
