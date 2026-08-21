import { test, expect, type Page } from "@playwright/test";

/**
 * iOS Safari (WebKit) guard for the sync badge under accessibility media
 * preferences.
 *
 * Two preferences change how the badge is painted on iOS:
 *   - `prefers-reduced-motion: reduce` — the global reset in src/styles.css
 *     neutralises transitions/animations. A regression here is usually a ring
 *     that fades in (invisible on the frame a user checks) or a tooltip that
 *     animates its own box.
 *   - `prefers-contrast: more` — Safari's Increase Contrast. Ring and border
 *     colors come from the semantic status tokens; if a future override drops
 *     them the ring can collapse to transparent while the badge still looks
 *     fine in the default mode.
 *
 * For every combination of (reduced motion on/off) x (contrast more/normal) x
 * (dark/light theme) this spec asserts, on WebKit:
 *   1. keyboard focus lands on the Retry button and paints a real, opaque,
 *      >=2px focus ring (box-shadow, since the ring utility is a shadow)
 *   2. the ring is present on the first measured frame and does not change
 *      (no fade-in that reduced-motion users would never see)
 *   3. the tooltip renders with visible text and a non-zero, stable box
 */

const LAB = "/dev/sync-badge-lab";
const THEMES = ["dark", "light"] as const;
const MOTIONS = ["reduce", "no-preference"] as const;
const CONTRASTS = ["more", "no-preference"] as const;

type Ring = { shadow: string; alpha: number; outline: string; width: number };

async function openLab(
  page: Page,
  motion: (typeof MOTIONS)[number],
  contrast: (typeof CONTRASTS)[number],
  theme: (typeof THEMES)[number],
) {
  await page.emulateMedia({ reducedMotion: motion, contrast });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(LAB);
  await expect(page.getByRole("heading", { name: "Sync badge lab" })).toBeVisible();

  // Guard the guard: if emulation stops reaching WebKit, fail loudly instead of
  // passing the assertions below for the wrong reason.
  const media = await page.evaluate(() => ({
    reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    contrast: matchMedia("(prefers-contrast: more)").matches,
  }));
  expect(media.reduce, `reduced-motion emulation (${motion}) did not reach the page`).toBe(
    motion === "reduce",
  );
  expect(media.contrast, `contrast emulation (${contrast}) did not reach the page`).toBe(
    contrast === "more",
  );
  await expect(page.getByTestId("lab-motion-readout")).toHaveAttribute(
    "data-reduced-motion",
    motion === "reduce" ? "reduce" : "no-preference",
  );

  if (theme === "light") {
    // The lab is a hydrated client component; a tap that lands before React
    // attaches handlers is silently dropped, so retry until the stage flips.
    const stage = page.getByTestId("lab-stage");
    for (let i = 0; i < 10; i += 1) {
      if ((await stage.getAttribute("data-theme")) === "light") break;
      await page.getByTestId("lab-theme-toggle").tap();
      await page.waitForTimeout(200);
    }
  }
  await expect(page.getByTestId("lab-stage")).toHaveAttribute("data-theme", theme);

  // The error phase is the only one with a Retry button.
  const stage = page.getByTestId("lab-stage");
  for (let i = 0; i < 10; i += 1) {
    if ((await stage.getAttribute("data-phase")) === "error") break;
    await page.getByTestId("lab-phase-error").tap();
    await page.waitForTimeout(200);
  }
  await expect(page.getByTestId("radio-sync-retry")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Tab until the Retry button owns focus (WebKit needs full keyboard modality). */
async function focusRetry(page: Page) {
  const retry = page.getByTestId("radio-sync-retry");
  for (let i = 0; i < 25; i += 1) {
    const focused = await retry.evaluate((el) => el === document.activeElement);
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Retry button never received keyboard focus");
}

/**
 * Alpha of an arbitrary CSS color, resolved by painting it. The design tokens
 * are `oklch(...)`, so string parsing for `rgba(...)` would report every ring
 * as transparent; a 1x1 canvas normalises any supported syntax.
 */
const ALPHA_OF = `(color) => {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d");
  if (!ctx) return 0;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
}`;

async function readRing(page: Page): Promise<Ring> {
  return page.getByTestId("radio-sync-retry").evaluate((el, alphaSrc) => {
    const alphaOf = eval(alphaSrc) as (c: string) => number;
    const s = getComputedStyle(el);
    const shadow = s.boxShadow;
    // Tailwind's ring renders as `<color> 0 0 0 <n>px`; grab the widest px.
    const widths = [...shadow.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    // Each comma-separated layer starts (or ends) with its color; strip the
    // lengths and keywords to isolate it, then paint it to read real alpha.
    const alpha = shadow
      .split(/,(?![^(]*\))/)
      .map((layer) => layer.replace(/-?\d+(?:\.\d+)?px/g, "").replace(/\binset\b/g, "").trim())
      .map((color) => (color ? alphaOf(color) : 0))
      .reduce((max, a) => Math.max(max, a), 0);
    return {
      shadow,
      alpha,
      outline: `${s.outlineStyle} ${s.outlineWidth}`,
      width: widths.length ? Math.max(...widths) : 0,
    };
  }, ALPHA_OF);
}

/** Non-transparent means an actual painted ring, not a see-through one. */
function ringIsOpaque(ring: Ring) {
  return ring.alpha > 0.5;
}


for (const motion of MOTIONS) {
  for (const contrast of CONTRASTS) {
    for (const theme of THEMES) {
      const label = `motion=${motion} contrast=${contrast} theme=${theme}`;

      test(`iOS Safari: Retry focus ring is painted and stable — ${label}`, async ({ page }) => {
        await openLab(page, motion, contrast, theme);

        const before = await readRing(page);
        expect(before.shadow === "none" || before.width === 0).toBe(true);

        await focusRetry(page);

        // First measured frame: no waiting, so a fade-in would be caught.
        const first = await readRing(page);
        expect(first.shadow, `no focus ring painted (${label})`).not.toBe("none");
        expect(first.width).toBeGreaterThanOrEqual(2);
        expect(ringIsOpaque(first), `focus ring is transparent (${label})`).toBe(true);

        await page.waitForTimeout(350);
        const settled = await readRing(page);
        if (motion === "reduce") {
          expect(settled.shadow, `focus ring animated under reduced motion (${label})`).toBe(
            first.shadow,
          );
        }
        expect(settled.width).toBeGreaterThanOrEqual(2);
        expect(ringIsOpaque(settled)).toBe(true);

        // Focus survives; the ring is not a transient paint.
        await expect(page.getByTestId("radio-sync-retry")).toBeFocused();
      });

      test(`iOS Safari: tooltip renders with a stable box — ${label}`, async ({ page }) => {
        await openLab(page, motion, contrast, theme);

        await page.getByTestId("lab-tooltip-toggle").tap();
        const tooltip = page.getByTestId("radio-sync-tooltip").first();
        await expect(tooltip).toBeVisible();

        const text = (await tooltip.innerText()).trim();
        expect(text.length, `tooltip rendered empty (${label})`).toBeGreaterThan(0);

        const first = await tooltip.boundingBox();
        expect(first, `tooltip has no box (${label})`).not.toBeNull();
        expect(first!.width).toBeGreaterThan(40);
        expect(first!.height).toBeGreaterThan(16);

        await page.waitForTimeout(350);
        const settled = await tooltip.boundingBox();
        if (motion === "reduce") {
          expect(Math.round(settled!.x), `tooltip drifted under reduced motion (${label})`).toBe(
            Math.round(first!.x),
          );
          expect(Math.round(settled!.y)).toBe(Math.round(first!.y));
          expect(Math.round(settled!.width)).toBe(Math.round(first!.width));
          expect(Math.round(settled!.height)).toBe(Math.round(first!.height));
        }

        // Tooltip content stays legible: an opaque surface, not see-through.
        const opaque = await tooltip.evaluate((el, alphaSrc) => {
          const alphaOf = eval(alphaSrc) as (c: string) => number;
          return alphaOf(getComputedStyle(el).backgroundColor) > 0.8;
        }, ALPHA_OF);
        expect(opaque, `tooltip surface is not opaque (${label})`).toBe(true);
      });
    }
  }
}
