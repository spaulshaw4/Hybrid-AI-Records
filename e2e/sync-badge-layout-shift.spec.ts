import { test, expect, type Page } from "@playwright/test";

/**
 * Layout-shift guard for the sync badge tooltip.
 *
 * The tooltip is portalled and absolutely positioned, so opening it must not
 * reflow anything: not the badge itself, not its sibling chips, not the page
 * scroll height. A regression here (rendering the tooltip inline, adding
 * margin to the trigger, or letting the popper widen the document and create a
 * scrollbar) would visibly nudge the surrounding UI.
 *
 * Two independent checks per case:
 *   1. geometry — every neighbouring element keeps its exact bounding box
 *   2. CLS — the browser reports no layout-shift entries while opening/closing
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;

/** Every element whose position must not move while the tooltip toggles. */
const WATCHED = "[data-testid^='badge-'], [data-testid^='badge-surface-'], h1, h2";

type Rect = { x: number; y: number; width: number; height: number };

async function openHarness(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  // Hydration re-renders the badge subtree, which detaches the SSR nodes; a
  // locator resolved before that point throws "not attached to the DOM".
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);

}

/** Snapshot the geometry of everything around the badge, keyed by test id. */
async function measure(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const map: Record<string, Rect> = {};
    type Rect = { x: number; y: number; width: number; height: number };
    document.querySelectorAll(sel).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const key = el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}-${i}`;
      // Round to whole pixels: sub-pixel jitter from font metrics is not a shift.
      map[key] = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
    return map;
  }, selector);
}

/** Starts recording layout-shift entries the browser attributes to the page. */
async function startCls(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: number[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // Shifts within 500ms of a real input are "expected" per CLS, but the
        // tooltip must not move anything at all, so count those too.
        w.__shifts.push((entry as unknown as { value: number }).value);
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
}

async function readCls(page: Page) {
  // One frame + observer flush before reading.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))));
  return page.evaluate(
    () => (window as unknown as { __shifts: number[] }).__shifts.reduce((a, b) => a + b, 0),
  );
}

/** Document scroll extents — a popper that widens the page adds a scrollbar. */
async function extents(page: Page) {
  return page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
}

for (const theme of THEMES) {
  test.describe(`SyncBadge tooltip layout shift (${theme})`, () => {
    test("hovering the badge open and closed moves nothing", async ({ page }) => {
      await openHarness(page);

      const badge = page.getByTestId(`badge-${theme}-resolved`);
      const trigger = badge.getByTestId("radio-sync-status");
      await badge.scrollIntoViewIfNeeded();
      // Freeze the scroll position so measurements share one coordinate space.
      await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

      const before = await measure(page, WATCHED);
      const extentsBefore = await extents(page);
      await startCls(page);

      await trigger.hover();
      await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

      const during = await measure(page, WATCHED);
      expect(during).toEqual(before);
      expect(await extents(page)).toEqual(extentsBefore);
      expect(await readCls(page), "opening the tooltip must not shift layout").toBe(0);

      // Move the pointer away in steps so pointerleave really fires.
      const box = (await trigger.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, Math.max(2, box.y - 250), { steps: 12 });
      await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(0);

      expect(await measure(page, WATCHED)).toEqual(before);
      expect(await extents(page)).toEqual(extentsBefore);
      expect(await readCls(page), "closing the tooltip must not shift layout").toBe(0);
    });

    test("keyboard focus open/Escape close moves nothing", async ({ page }) => {
      await openHarness(page);

      const badge = page.getByTestId(`badge-${theme}-conflict`);
      const trigger = badge.getByTestId("radio-sync-status");
      await badge.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

      const before = await measure(page, WATCHED);
      await startCls(page);

      await trigger.focus();
      await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);
      expect(await measure(page, WATCHED)).toEqual(before);

      await page.keyboard.press("Escape");
      await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(0);
      expect(await measure(page, WATCHED)).toEqual(before);
      expect(await readCls(page), "focus/Escape must not shift layout").toBe(0);
    });

    test("the error badge tooltip does not push the Retry button", async ({ page }) => {
      await openHarness(page);

      const badge = page.getByTestId(`badge-${theme}-error`);
      const retry = badge.getByTestId("radio-sync-retry");
      await badge.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

      const retryBefore = (await retry.boundingBox())!;
      const before = await measure(page, WATCHED);

      await badge.getByTestId("radio-sync-status").hover();
      await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

      const retryAfter = (await retry.boundingBox())!;
      expect(Math.round(retryAfter.x)).toBe(Math.round(retryBefore.x));
      expect(Math.round(retryAfter.y)).toBe(Math.round(retryBefore.y));
      expect(Math.round(retryAfter.width)).toBe(Math.round(retryBefore.width));
      expect(await measure(page, WATCHED)).toEqual(before);
    });
  });
}

/**
 * Narrow viewports are where a mis-positioned popper is most likely to widen
 * the document, so re-run the checks at phone widths in both themes.
 *
 * 320 = smallest supported phone, 360 = most common Android, 390 = iPhone 14/15,
 * 430 = iPhone Pro Max. The wide gap between 360 and 430 matters because the
 * popper flips its side/alignment as available space changes, and a flip is
 * exactly the moment a badly-anchored tooltip starts pushing the document.
 */
const NARROW_WIDTHS = [320, 360, 390, 430] as const;

async function openNarrowHarness(page: Page, width: number, search = "") {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(`${HARNESS}${search}`);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  // Tooltips ignore focus/hover until React has attached its listeners, and a
  // swallowed event has no follow-up to recover from.
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

for (const width of NARROW_WIDTHS) {
  for (const theme of THEMES) {
    test.describe(`SyncBadge tooltip layout shift @${width}px (${theme})`, () => {
      test("focus open and Escape close move nothing", async ({ page }) => {
        await openNarrowHarness(page, width);

        const badge = page.getByTestId(`badge-${theme}-resolved`);
        const trigger = badge.getByTestId("radio-sync-status");
        await badge.scrollIntoViewIfNeeded();
        // Freeze scroll so every measurement shares one coordinate space.
        await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

        const before = await measure(page, WATCHED);
        const extentsBefore = await extents(page);
        await startCls(page);

        await trigger.focus();
        await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

        expect(await measure(page, WATCHED), "opening must not move neighbours").toEqual(before);
        // A popper that overflows horizontally is the classic narrow-width bug:
        // it widens the document and summons a scrollbar.
        expect(await extents(page), "opening must not widen the document").toEqual(extentsBefore);
        expect(await readCls(page), "opening the tooltip must not shift layout").toBe(0);

        await page.keyboard.press("Escape");
        await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(0);

        expect(await measure(page, WATCHED)).toEqual(before);
        expect(await extents(page)).toEqual(extentsBefore);
        expect(await readCls(page), "closing the tooltip must not shift layout").toBe(0);
      });

      test("the error badge tooltip does not push Retry", async ({ page }) => {
        await openNarrowHarness(page, width);

        const badge = page.getByTestId(`badge-${theme}-error`);
        const retry = badge.getByTestId("radio-sync-retry");
        await badge.scrollIntoViewIfNeeded();
        await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

        const retryBefore = (await retry.boundingBox())!;
        const before = await measure(page, WATCHED);
        const extentsBefore = await extents(page);

        await badge.getByTestId("radio-sync-status").focus();
        await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

        const retryAfter = (await retry.boundingBox())!;
        expect(Math.round(retryAfter.x)).toBe(Math.round(retryBefore.x));
        expect(Math.round(retryAfter.y)).toBe(Math.round(retryBefore.y));
        expect(Math.round(retryAfter.width)).toBe(Math.round(retryBefore.width));
        expect(await measure(page, WATCHED)).toEqual(before);
        expect(await extents(page)).toEqual(extentsBefore);
      });

      test("a pinned-open tooltip yields the same geometry as a closed one", async ({ page }) => {
        // Independent of the interactive checks above: this one compares two
        // fresh loads, so it also catches a tooltip that shifts layout during
        // the initial render rather than on toggle.
        await openNarrowHarness(page, width, `?tooltip=${theme}:resolved`);
        await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

        const pinned = await measure(page, WATCHED);
        const pinnedExtents = await extents(page);

        await openNarrowHarness(page, width);
        expect(await measure(page, WATCHED)).toEqual(pinned);
        expect(await extents(page)).toEqual(pinnedExtents);
      });
    });
  }
}

