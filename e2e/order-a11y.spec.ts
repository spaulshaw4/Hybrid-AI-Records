import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

const CTA = 'a[aria-controls="quick-order-form"]';
const FIRST_FIELD = "#qo-artist";
const ORDER_FORM = "#quick-order-form";

/** id of the element that currently has focus (empty string when none). */
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

/** Sticky-header height, used to prove the focused field is not hidden under it. */
const headerHeight = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector("header");
    return header instanceof HTMLElement ? header.offsetHeight : 0;
  });

/** Wait until deep-link / CTA focus lands on the first intake field. */
async function expectOrderFieldFocused(page: Page) {
  await expect(page.locator(ORDER_FORM)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => activeId(page), { timeout: 12_000, intervals: [50, 100, 200] })
    .toBe("qo-artist");
  await expect(page.locator(FIRST_FIELD)).toBeFocused();
}

test.describe("Order form accessibility", () => {
  test("Connect & Order shows a visible focus ring when keyboard-focused", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.scrollIntoViewIfNeeded();

    const styleOf = () =>
      cta.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          outlineStyle: s.outlineStyle,
          outlineWidth: parseFloat(s.outlineWidth || "0"),
          boxShadow: s.boxShadow,
        };
      });

    const blurred = await styleOf();
    // Keyboard focus (not mouse) so :focus-visible applies.
    await cta.evaluate((el) => (el as HTMLElement).focus());
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(cta).toBeFocused();

    const focused = await styleOf();
    const hasRing =
      (focused.outlineStyle !== "none" && focused.outlineWidth >= 1) ||
      (focused.boxShadow !== "none" && focused.boxShadow !== blurred.boxShadow);
    expect(hasRing, `no visible focus indicator: ${JSON.stringify(focused)}`).toBe(true);
  });

  test("clicking the CTA focuses the first field and Escape returns focus", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();

    await expectOrderFieldFocused(page);
    expect(page.url()).toContain("#order");

    await page.keyboard.press("Escape");
    await expect.poll(() => activeId(page), { timeout: 8_000 }).not.toBe("qo-artist");
    await expect(cta).toBeFocused();
  });

  test("deep link to /portal#order scrolls the first field clear of the sticky header", async ({
    page,
  }) => {
    await page.goto("/portal#order", { waitUntil: "domcontentloaded" });
    const field = page.locator(FIRST_FIELD);
    await expectOrderFieldFocused(page);

    const [box, header] = await Promise.all([field.boundingBox(), headerHeight(page)]);
    expect(box).not.toBeNull();
    // Fully inside the viewport and below the sticky header.
    expect(box!.y).toBeGreaterThanOrEqual(header - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  });

  test("back/forward navigation restores focus on both sides of #order", async ({ page }) => {
    await page.goto("/portal", { waitUntil: "domcontentloaded" });
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();
    await expectOrderFieldFocused(page);

    await page.goBack();
    await expect(cta).toBeFocused({ timeout: 8_000 });
    expect(page.url()).not.toContain("#order");

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
  await page.goto("/portal#order", { waitUntil: "domcontentloaded" });
  await expectOrderFieldFocused(page);
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
}

test.describe("Order form axe-core audit", () => {
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
    await page.goto("/portal#order", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#order")).toBeVisible({ timeout: 15_000 });
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
