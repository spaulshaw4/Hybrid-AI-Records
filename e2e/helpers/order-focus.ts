import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared waits for the /portal#order deep-link + keyboard focus gate.
 *
 * Headless CI (GitHub Actions) is colder than local: Vite's first compile of
 * /portal can land after domcontentloaded, smooth-scroll correction can still
 * be mid-flight when focus settles, and Escape/history focus return races a
 * couple of rAF passes. These helpers poll through those windows instead of
 * asserting once.
 */

export const ORDER_CTA = 'a[aria-controls="quick-order-form"]';
export const ORDER_FIRST_FIELD = "#qo-artist";
export const ORDER_FORM = "#quick-order-form";
export const ORDER_SECTION = "#order";

/** Longer budgets under CI; keep local runs snappy. */
const CI = !!process.env.CI;
export const ORDER_VISIBLE_MS = CI ? 30_000 : 15_000;
export const ORDER_FOCUS_MS = 20_000;
export const ORDER_SCROLL_MS = CI ? 15_000 : 8_000;
export const ORDER_RETURN_MS = CI ? 12_000 : 8_000;

export const activeId = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? "");

/** Sticky/fixed header height used by the intake scroll offset (0 when lg:hidden). */
export const headerHeight = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector("header");
    return header instanceof HTMLElement ? header.offsetHeight : 0;
  });

/** Navigate and wait until the portal intake chrome is actually mounted. */
export async function gotoPortal(page: Page, path = "/portal") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(ORDER_SECTION)).toBeVisible({ timeout: ORDER_VISIBLE_MS });
  await expect(page.locator(ORDER_FORM)).toBeVisible({ timeout: ORDER_VISIBLE_MS });
  await expect(page.locator(ORDER_FIRST_FIELD)).toBeEnabled({ timeout: ORDER_VISIBLE_MS });
}

/** Wait until deep-link / CTA focus lands on the first intake field. */
export async function expectOrderFieldFocused(page: Page) {
  await expect(page.locator(ORDER_FORM)).toBeVisible({ timeout: ORDER_VISIBLE_MS });
  await expect(page.locator(ORDER_FIRST_FIELD)).toBeEnabled({ timeout: ORDER_VISIBLE_MS });
  await expect
    .poll(async () => activeId(page), {
      timeout: ORDER_FOCUS_MS,
      intervals: [50, 100, 200, 400],
    })
    .toBe("qo-artist");
  await expect(page.locator(ORDER_FIRST_FIELD)).toBeFocused({ timeout: ORDER_FOCUS_MS });
}

/**
 * Poll until the focused artist field sits fully in the viewport and below the
 * sticky header — smooth-scroll correction can take >1s on throttled CI CPUs.
 */
export async function expectFieldClearOfStickyHeader(page: Page, field: Locator) {
  await expect
    .poll(
      async () => {
        const [box, header, viewport] = await Promise.all([
          field.boundingBox(),
          headerHeight(page),
          page.viewportSize(),
        ]);
        if (!box || !viewport) return "missing-geometry";
        const aboveHeader = box.y + 1 < header;
        const belowFold = box.y + box.height - 1 > viewport.height;
        if (aboveHeader) return `under-header:y=${box.y.toFixed(1)},header=${header}`;
        if (belowFold) return `below-fold:bottom=${(box.y + box.height).toFixed(1)},vh=${viewport.height}`;
        return "ok";
      },
      { timeout: ORDER_SCROLL_MS, intervals: [50, 100, 200, 400] },
    )
    .toBe("ok");
}

/** Escape / history.back must restore focus to the Connect & Order CTA. */
export async function expectOrderCtaFocused(page: Page, cta: Locator) {
  await expect
    .poll(async () => activeId(page), { timeout: ORDER_RETURN_MS, intervals: [50, 100, 200] })
    .not.toBe("qo-artist");
  await expect(cta).toBeFocused({ timeout: ORDER_RETURN_MS });
}

/** Poll until the address bar matches (alias canonicalization is async on mount). */
export async function expectUrlIncludes(page: Page, snippet: string) {
  await expect
    .poll(() => page.url(), { timeout: ORDER_FOCUS_MS, intervals: [50, 100, 200] })
    .toContain(snippet);
}
