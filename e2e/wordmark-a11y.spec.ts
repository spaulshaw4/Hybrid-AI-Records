import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * Browser-level accessibility gate for the brand logo links.
 *
 * jsdom (`src/test/wordmark-a11y.test.tsx`) covers markup semantics but cannot
 * score colour or paint a focus ring. This suite runs the full axe rule set —
 * including `color-contrast` — against the real header and footer lockups, and
 * asserts that keyboard focus produces a visibly rendered ring in both themes.
 */

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const HEADER_LINK = 'header a[aria-label="Hybrid AI Records — back to top"]';
const FOOTER_LINK = 'footer a[aria-label="Hybrid AI Records — back to top"]';

type Violation = { id: string; impact?: string | null; help: string; nodes: string[] };

async function axeOn(page: Page, selector: string): Promise<Violation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    // @ts-expect-error injected global
    const results = await window.axe.run(sel, { resultTypes: ["violations"] });
    return results.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.map((n: any) => n.html),
    }));
  }, selector);
}

async function setTheme(page: Page, theme: "dark" | "light") {
  // The app scopes its light surface with `.theme-light`; dark is the :root default.
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("theme-light", t === "light");
  }, theme);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(HEADER_LINK).waitFor();
});

test.describe("logo link accessible name", () => {
  for (const [where, selector] of [
    ["header", HEADER_LINK],
    ["footer", FOOTER_LINK],
  ] as const) {
    test(`${where} lockup exposes exactly one accessible name`, async ({ page }) => {
      const link = page.locator(selector).first();
      await expect(link).toHaveCount(1);
      // The computed a11y name must be the label, not label + duplicated alt.
      const name = await link.evaluate((el) => el.getAttribute("aria-label"));
      expect(name).toBe("Hybrid AI Records — back to top");
      await expect(link).toBeVisible();
    });

    test(`${where} mark is decorative when the lettering is visible`, async ({ page }) => {
      const img = page.locator(`${selector} img`).first();
      const showsText = await page.locator(`${selector} span.font-display`).first().isVisible();
      const [alt, hidden] = await img.evaluate((el) => [
        el.getAttribute("alt"),
        el.getAttribute("aria-hidden"),
      ]);
      if (showsText) {
        expect(alt).toBe("");
        expect(hidden).toBe("true");
      } else {
        expect(alt).toBe("Hybrid AI Records");
      }
      // Either way the image must resolve — a broken mark leaves an empty link.
      await expect
        .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
    });
  }
});

test.describe("logo link keyboard focus ring", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`header link paints a visible focus ring in ${theme} theme`, async ({ page }) => {
      await setTheme(page, theme);
      const link = page.locator(HEADER_LINK).first();

      const resting = await link.evaluate((el) => getComputedStyle(el).boxShadow);

      // Keyboard focus (not .focus()) so :focus-visible actually matches.
      await page.keyboard.press("Tab");
      for (let i = 0; i < 12; i++) {
        if (await link.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("Tab");
      }
      await expect(link).toBeFocused();

      const focused = await link.evaluate((el) => {
        const s = getComputedStyle(el);
        return { boxShadow: s.boxShadow, outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
      });

      const ringVisible =
        (focused.boxShadow !== "none" && focused.boxShadow !== resting) ||
        (focused.outlineStyle !== "none" && parseFloat(focused.outlineWidth) >= 1);
      expect(ringVisible, `no focus indicator in ${theme}: ${JSON.stringify(focused)}`).toBe(true);
    });
  }

  test("Enter activation jumps to top and keeps focus reachable", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 800));
    const link = page.locator(HEADER_LINK).first();
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#top$/);
    // Fragment navigation may hand focus to the target; the link must remain in
    // the tab order so keyboard users can return to it.
    await expect(link).toBeVisible();
    const active = await page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(["A", "BODY", "HTML"]).toContain(active);
  });
});

test.describe("axe-core: logo links", () => {
  for (const [where, selector] of [
    ["header", HEADER_LINK],
    ["footer", FOOTER_LINK],
  ] as const) {
    for (const theme of ["dark", "light"] as const) {
      test(`${where} lockup has zero violations in ${theme} theme`, async ({ page }) => {
        await setTheme(page, theme);
        expect(await axeOn(page, selector)).toEqual([]);
      });
    }
  }

  test("focused header lockup has zero violations", async ({ page }) => {
    await page.locator(HEADER_LINK).first().focus();
    expect(await axeOn(page, HEADER_LINK)).toEqual([]);
  });
});
