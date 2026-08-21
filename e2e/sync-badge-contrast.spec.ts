import { test, expect, type Page } from "@playwright/test";

/**
 * WCAG contrast and focus-ring validation for the sync badge.
 *
 * Runs against the internal harness at /dev/sync-badge, which renders every
 * badge state on both a dark and a light surface. Colours are read from the
 * live computed styles and composited against the real ancestor backgrounds
 * (the badge uses translucent fills like `bg-destructive/10`, so a naive
 * background read would be wrong), then scored with the WCAG 2.1 relative
 * luminance formula.
 *
 * Thresholds: 4.5:1 for the small badge text, 3:1 for the focus ring and the
 * badge border, which are non-text UI components (WCAG 1.4.11).
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;
const TEXT_AA = 4.5;
const NON_TEXT_AA = 3;

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await expect(page.getByTestId("sync-badge-harness")).toHaveAttribute("data-hydrated", "true");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Installs colour maths in the page: parse → alpha-composite over the real
 * ancestor stack → WCAG relative luminance → contrast ratio.
 */
async function installContrastTools(page: Page) {
  await page.evaluate(() => {
    type RGBA = [number, number, number, number];

    // The design system is authored in OKLCH, so computed values come back as
    // `oklch(...)`. Painting into a canvas lets the browser do the conversion
    // to sRGB for us instead of hand-rolling a colour-space transform.
    const probe = document.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;

    const parse = (value: string): RGBA => {
      if (!value || value === "none" || value === "transparent") return [0, 0, 0, 0];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r!, g!, b!, a! / 255];
    };

    const over = (fg: RGBA, bg: RGBA): RGBA => {
      const a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
        1,
      ];
    };

    /** Effective painted background behind an element, walking up ancestors. */
    const bgOf = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      let node: Element | null = el;
      while (node) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
        node = node.parentElement;
      }
      let base: RGBA = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base);
      return base;
    };

    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };

    const ratio = (a: RGBA, b: RGBA) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
      return (x + 0.05) / (y + 0.05);
    };

    (window as unknown as Record<string, unknown>).__contrast = {
      /** Text (or border) colour against its effective background. */
      of(selector: string, prop: "color" | "borderTopColor") {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`missing element: ${selector}`);
        const bg = bgOf(el.parentElement ?? el);
        const fg = over(parse(getComputedStyle(el)[prop]), bg);
        return { ratio: ratio(fg, bg), fg: getComputedStyle(el)[prop], bg: `rgb(${bg.slice(0, 3).join(",")})` };
      },
      /** Focus ring colour (Tailwind rings paint as box-shadow) vs the page. */
      ring(selector: string) {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`missing element: ${selector}`);
        const style = getComputedStyle(el);
        // A ring can be painted either as a box-shadow (Tailwind `ring-*`) or
        // as a real outline (the global focus-visible rule); accept both.
        const outlineWidth = parseFloat(style.outlineWidth) || 0;
        const useOutline = outlineWidth > 0 && style.outlineStyle !== "none";
        const shadow = useOutline ? `outline ${style.outlineColor}` : style.boxShadow;
        const visibleShadow =
          !useOutline && /(rgba?\([^)]*,\s*0\)|\/\s*0\))/.test(shadow)
            ? shadow.split(/,(?![^(]*\))/).some((seg) => !/(,\s*0\)|\/\s*0\))/.test(seg))
            : true;
        if (!shadow || shadow === "none" || !visibleShadow) return { present: false, ratio: 0, shadow };
        // A Tailwind ring paints two shadow segments: the offset (page colour)
        // and the ring itself. Pick the segment with the widest spread, which
        // is the visible ring, not the offset gap.
        const segments = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
        let ringColor = parse("rgb(0,0,0)");
        let widest = -1;
        for (const segment of segments) {
          const color = segment.match(/rgba?\([^)]+\)|oklch\([^)]+\)|#[0-9a-f]+/i)?.[0] ?? "rgb(0,0,0)";
          const lengths = (segment.replace(color, "").match(/-?[\d.]+px/g) ?? []).map(parseFloat);
          const spread = lengths.length ? lengths[lengths.length - 1]! : 0;
          if (spread > widest) {
            widest = spread;
            ringColor = parse(color);
          }
        }
        const bg = bgOf(el.parentElement ?? el);
        return { present: true, ratio: ratio(over(ringColor, bg), bg), shadow };
      },
    };
  });
}

type Contrast = { ratio: number; fg: string; bg: string };
type Ring = { present: boolean; ratio: number; shadow: string };

const contrastOf = (page: Page, selector: string, prop: "color" | "borderTopColor" = "color") =>
  page.evaluate(
    ({ selector, prop }) => (window as any).__contrast.of(selector, prop) as Contrast,
    { selector, prop },
  );

const ringOf = (page: Page, selector: string) =>
  page.evaluate((selector) => (window as any).__contrast.ring(selector) as Ring, selector);

/** Waits until the element's box-shadow stops changing (transition finished). */
async function settle(page: Page, selector: string) {
  await page.waitForFunction(
    (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const now = getComputedStyle(el).boxShadow;
      const store = window as unknown as Record<string, string>;
      const key = `__shadow:${selector}`;
      const previous = store[key];
      store[key] = now;
      return previous === now;
    },
    selector,
    { polling: 120, timeout: 5000 },
  );
}

const sel = (theme: string, id: string, testid: string) =>
  `[data-testid="badge-${theme}-${id}"] [data-testid="${testid}"]`;

test.describe("SyncBadge contrast and focus rings", () => {
  for (const theme of THEMES) {
    test(`badge text meets WCAG AA on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await installContrastTools(page);

      const cases: Array<[string, string]> = [
        ["synced-aligned", "radio-sync-status"],
        ["resolving", "radio-sync-status"],
        ["resolved", "radio-sync-status"],
        ["conflict", "radio-sync-status"],
        ["error", "radio-sync-status"],
        ["error", "radio-sync-retry"],
      ];

      for (const [id, testid] of cases) {
        const result = await contrastOf(page, sel(theme, id, testid));
        expect(
          result.ratio,
          `${theme}/${id}/${testid}: ${result.fg} on ${result.bg} = ${result.ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(TEXT_AA);
      }
    });

    test(`the last-aligned chip stays readable on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await installContrastTools(page);
      // This chip is rendered at reduced opacity — the most likely regression.
      const result = await contrastOf(page, sel(theme, "resolved", "radio-sync-last-resolved"));
      expect(result.ratio, `last-aligned chip = ${result.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_AA);
    });

    test(`badge borders clear the non-text threshold on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await installContrastTools(page);

      for (const id of ["synced-aligned", "error"]) {
        const result = await contrastOf(page, sel(theme, id, "radio-sync-status"), "borderTopColor");
        expect(result.ratio, `${theme}/${id} border = ${result.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          NON_TEXT_AA,
        );
      }
    });

    test(`keyboard focus paints a visible, high-contrast ring on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await installContrastTools(page);

      const badgeSel = sel(theme, "synced-aligned", "radio-sync-status");
      const retrySel = sel(theme, "error", "radio-sync-retry");

      // No ring before focus.
      expect((await ringOf(page, badgeSel)).present).toBe(false);

      for (const selector of [badgeSel, retrySel]) {
        // Chromium only matches :focus-visible when focus arrives by keyboard,
        // so step off the target and Tab back onto it like a real user.
        await page.locator(selector).focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(page.locator(selector)).toBeFocused();
        // The badge transitions into its ring; sample only the settled value.
        await settle(page, selector);
        const ring = await ringOf(page, selector);
        expect(ring.present, `no focus ring on ${selector}: ${ring.shadow}`).toBe(true);
        expect(
          ring.ratio,
          `${theme} focus ring on ${selector} = ${ring.ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(NON_TEXT_AA);
      }
    });

    test(`the tooltip body meets WCAG AA on the ${theme} surface`, async ({ page }) => {
      await openHarness(page);
      await installContrastTools(page);

      await page.locator(sel(theme, "resolved", "radio-sync-status")).focus();
      const tooltip = page.getByTestId("radio-sync-tooltip").first();
      await expect(tooltip).toBeVisible();

      const result = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="radio-sync-tooltip"]')!;
        return (window as any).__contrast.of(`#${(el.id ||= "at-tooltip")}`, "color") as Contrast;
      });
      expect(result.ratio, `tooltip text = ${result.ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(TEXT_AA);
    });
  }
});
