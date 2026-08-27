import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import {
  ORDER_CTA,
  ORDER_FIRST_FIELD,
  ORDER_SECTION,
  ORDER_VISIBLE_MS,
  expectFieldClearOfStickyHeader,
  expectOrderCtaFocused,
  expectOrderFieldFocused,
  expectUrlIncludes,
  gotoPortal,
} from "./helpers/order-focus";

const CTA = ORDER_CTA;
const FIRST_FIELD = ORDER_FIRST_FIELD;

test.describe("Order form accessibility", () => {
  // Cold Vite compiles of /portal on CI runners need headroom beyond the default 60s.
  test.describe.configure({ timeout: 90_000 });

  test("Connect & Order shows a visible focus ring when keyboard-focused", async ({ page }) => {
    await gotoPortal(page);
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await cta.scrollIntoViewIfNeeded();

    const styleOf = () =>
      cta.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          outlineStyle: s.outlineStyle,
          outlineWidth: parseFloat(s.outlineWidth || "0"),
          boxShadow: s.boxShadow,
          focusVisible: el.matches(":focus-visible"),
        };
      });

    const blurred = await styleOf();
    // Reset modality, then Tab onto the CTA so :focus-visible (not mouse :focus) applies.
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await cta.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(cta).toBeFocused({ timeout: ORDER_VISIBLE_MS });

    await expect
      .poll(async () => {
        const focused = await styleOf();
        const hasRing =
          focused.focusVisible ||
          (focused.outlineStyle !== "none" && focused.outlineWidth >= 1) ||
          (focused.boxShadow !== "none" && focused.boxShadow !== blurred.boxShadow);
        return hasRing ? "ring" : JSON.stringify(focused);
      }, { timeout: 5_000, intervals: [50, 100, 200] })
      .toBe("ring");
  });

  test("clicking the CTA focuses the first field and Escape returns focus", async ({ page }) => {
    await gotoPortal(page);
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await cta.click();

    await expectOrderFieldFocused(page);
    await expectUrlIncludes(page, "#order");

    await page.keyboard.press("Escape");
    await expectOrderCtaFocused(page, cta);
  });

  test("deep link to /portal#order scrolls the first field clear of the sticky header", async ({
    page,
  }) => {
    await gotoPortal(page, "/portal#order");
    const field = page.locator(FIRST_FIELD);
    await expectOrderFieldFocused(page);
    await expectFieldClearOfStickyHeader(page, field);
  });

  test("back/forward navigation restores focus on both sides of #order", async ({ page }) => {
    await gotoPortal(page);
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await cta.click();
    await expectOrderFieldFocused(page);

    await page.goBack();
    await expectOrderCtaFocused(page, cta);
    await expect
      .poll(() => page.url(), { timeout: ORDER_VISIBLE_MS })
      .not.toContain("#order");

    await page.goForward();
    await expectOrderFieldFocused(page);
  });
});

/* ------------------------------------------------------------------ *
 * axe-core audit — catches missing ARIA labels, colour-contrast
 * failures, and invalid/duplicated landmarks on the order flow.
 * ------------------------------------------------------------------ */

const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

type Violation = { id: string; impact?: string | null; help: string; nodes: string[] };

/** Injects axe and scans one subtree, returning a compact violation list. */
async function scan(page: Page, selector: string): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE_PATH });
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

const report = (violations: Violation[]) =>
  violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.join("\n  ")}`).join("\n");

async function openOrderForm(page: Page) {
  await gotoPortal(page, "/portal#order");
  await expectOrderFieldFocused(page);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
}

test.describe("Order form axe-core audit", () => {
  test.describe.configure({ timeout: 90_000 });

  test("entry step has no accessibility violations", async ({ page }) => {
    await openOrderForm(page);
    const violations = await scan(page, "#order");
    expect(report(violations), report(violations)).toBe("");
  });

  test("review step has no accessibility violations", async ({ page }) => {
    await openOrderForm(page);
    await page.fill("#qo-artist", "Test Artist");
    await page.fill("#qo-email", "artist@example.com");
    await page.fill("#qo-link", "https://example.com/demo.wav");
    await page.getByRole("button", { name: /review your order/i }).click();
    await expect(page.getByText(/review your order/i).first()).toBeVisible();

    const violations = await scan(page, "#order");
    expect(report(violations), report(violations)).toBe("");
  });

  test("page landmarks are valid and unique", async ({ page }) => {
    await gotoPortal(page, "/portal#order");
    await expect(page.locator(ORDER_SECTION)).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await page.addScriptTag({ path: AXE_PATH });

    const violations = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const axe = (window as any).axe;
      const results = await axe.run(document, {
        resultTypes: ["violations"],
        runOnly: {
          type: "rule",
          values: [
            "landmark-one-main",
            "landmark-no-duplicate-main",
            "landmark-no-duplicate-banner",
            "landmark-no-duplicate-contentinfo",
            "landmark-unique",
            "region",
            "duplicate-id-aria",
          ],
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return results.violations.map((v: any) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodes: v.nodes.map((n: any) => n.html),
      })) as Violation[];
    });

    expect(report(violations), report(violations)).toBe("");
  });
});
