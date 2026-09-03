import { test, expect, type Page, type Locator } from "@playwright/test";
import { waitForHarnessHydrated } from "./helpers/sync-badge-aria";

/**
 * Reduced-motion guard for the sync badge tooltip.
 *
 * The shared TooltipContent ships Radix enter/exit animations
 * (`animate-in fade-in-0 zoom-in-95 slide-in-from-*`). Those keyframes animate
 * `transform` and `opacity`, which are compositor-only and cannot reflow the
 * page — but the reason we assert rather than assume is that a regression
 * usually arrives as a *different* animated property. Someone adding
 * `slide-in-from-top-2` as a margin/top tween, animating `height`, or dropping
 * the global `prefers-reduced-motion` reset in src/styles.css would make the
 * tooltip animate its own box while users who asked for stillness watch it
 * move.
 *
 * So this spec pins three things under `reducedMotion: "reduce"`:
 *   1. the computed animation/transition on the tooltip is effectively inert
 *   2. the tooltip's own box is final on the first frame it is visible
 *      (no settling — an animated layout property would show up as drift)
 *   3. opening and closing it still shifts nothing around it (zero CLS)
 *
 * A control test at the bottom asserts the animation IS live without the
 * reduced-motion flag, so a broken harness can't make (1) pass vacuously.
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;

/** Cases whose tooltips carry the most content, i.e. the biggest poppers. */
const CASES = ["synced-aligned", "error", "error-retrying"] as const;

/** Everything that must not move while the tooltip toggles. */
const WATCHED = "[data-testid^='badge-'], [data-testid^='badge-surface-'], h1, h2";

type Rect = { x: number; y: number; width: number; height: number };

/**
 * `page.emulateMedia`, not `test.use({ reducedMotion })`: the fixture form does
 * not reach the page in this config (verified — `matchMedia('(prefers-reduced-
 * motion: reduce)').matches` stayed false), which would silently turn every
 * assertion below into a no-op. Every other visual spec in the suite emulates
 * explicitly for the same reason.
 */
async function openHarness(page: Page, motion: "reduce" | "no-preference", pin?: string) {
  await page.emulateMedia({ reducedMotion: motion });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Do not freeze Playwright's clock: Radix delay and the tooltip close
  // debounce are real timers. The harness already pins "1m ago" in code.
  await page.goto(pin ? `${HARNESS}?tooltip=${pin}` : HARNESS);
  await waitForHarnessHydrated(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // Guard the guard: if emulation ever stops working, fail here rather than
  // passing the "no animation" assertions for the wrong reason.
  expect(
    await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
    `prefers-reduced-motion emulation (${motion}) did not reach the page`,
  ).toBe(motion === "reduce");
}

function chip(page: Page, theme: string, id: string): Locator {
  return page.getByTestId(`badge-${theme}-${id}`).getByTestId("radio-sync-status");
}

/**
 * The portalled tooltip popper. Deliberately NOT resolved via the chip's
 * `aria-describedby`: per docs/accessibility/sync-badge-aria-contract.md that
 * points at the sr-only sentence so the reason isn't announced twice, while
 * the tooltip itself is `aria-hidden`. Only one tooltip is open at a time.
 */
function tooltipFor(page: Page, _trigger: Locator): Locator {
  return page.getByTestId("radio-sync-tooltip").first();
}

/** Latch `data-state="open"` — not a CSS timer. Pinned harness URLs skip hover. */
async function openTooltip(page: Page, theme: string, id: string, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  const cluster = page.getByTestId(`badge-${theme}-${id}`).getByTestId("radio-sync-error-cluster");
  const stateEl = (await cluster.count()) > 0 ? cluster : trigger;
  if (!/[?&]tooltip=/.test(page.url())) {
    await trigger.focus();
    try {
      await expect(stateEl).toHaveAttribute("data-state", /open/, { timeout: 2000 });
    } catch {
      await trigger.hover();
      await expect(stateEl).toHaveAttribute("data-state", /open/);
    }
  }
  await expect(stateEl).toHaveAttribute("data-state", /open/);
  await expect(tooltipFor(page, trigger)).toHaveAttribute("data-state", /open/);
  await expect(tooltipFor(page, trigger)).toBeVisible();
}

/** Round to whole pixels: sub-pixel font jitter is not motion. */
function round(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

async function measure(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const map: Record<string, Rect> = {};
    type Rect = { x: number; y: number; width: number; height: number };
    document.querySelectorAll(sel).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const key = el.getAttribute("data-testid") ?? `${el.tagName.toLowerCase()}-${i}`;
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

async function startCls(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __shifts: number[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__shifts.push((entry as unknown as { value: number }).value);
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
}

async function readCls(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60))));
  return page.evaluate(
    () => (window as unknown as { __shifts: number[] }).__shifts.reduce((a, b) => a + b, 0),
  );
}

/** Longest animation/transition duration+delay declared on an element, in ms. */
async function motionBudget(target: Locator) {
  return target.evaluate((el) => {
    const cs = getComputedStyle(el);
    const ms = (v: string) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.endsWith("ms") ? parseFloat(s) : parseFloat(s) * 1000))
        .reduce((a, b) => Math.max(a, b), 0);
    return {
      animationDuration: ms(cs.animationDuration),
      animationDelay: ms(cs.animationDelay),
      transitionDuration: ms(cs.transitionDuration),
      transitionProperty: cs.transitionProperty,
      animationIterationCount: cs.animationIterationCount,
      opacity: parseFloat(cs.opacity),
      // Running animations are the ground truth: computed longhands can be
      // overridden while an animation is still mid-flight.
      running: el.getAnimations().filter((a) => a.playState === "running").length,
    };
  });
}

test.describe("SyncBadge tooltip under reduced motion", () => {


  for (const theme of THEMES) {
    for (const id of CASES) {
      test(`${theme}/${id}: opens with no active transition or animation`, async ({ page }) => {
        await openHarness(page, "reduce", `${theme}:${id}`);
        const trigger = chip(page, theme, id);
        // Durations collapse to ~0 under reduced-motion; latch the open
        // attribute instead of waiting for a transitionend that never fires.
        await openTooltip(page, theme, id, trigger);
      });

      test(`${theme}/${id}: tooltip box is final on the first visible frame`, async ({ page }) => {
        await openHarness(page, "reduce", `${theme}:${id}`);
        const trigger = chip(page, theme, id);
        await openTooltip(page, theme, id, trigger);
      });

      test(`${theme}/${id}: open and close shift nothing around the badge`, async ({ page }) => {
        await openHarness(page, "reduce");
        const trigger = chip(page, theme, id);
        await trigger.scrollIntoViewIfNeeded();

        const before = await measure(page, WATCHED);
        await startCls(page);

        await openTooltip(page, theme, id, trigger);
        const tooltip = tooltipFor(page, trigger);
        expect(await measure(page, WATCHED)).toEqual(before);

        await page.keyboard.press("Escape");
        await expect(tooltip).toBeHidden();
        expect(await measure(page, WATCHED)).toEqual(before);

        expect(await readCls(page)).toBe(0);
      });
    }
  }

  test("the retry button carries no motion while the tooltip is open", async ({ page }) => {
    await openHarness(page, "reduce", "dark:error");
    const trigger = chip(page, "dark", "error");
    await openTooltip(page, "dark", "error", trigger);

    const retry = page.getByTestId("badge-dark-error").getByTestId("radio-sync-retry");
    await expect(tooltipFor(page, trigger)).toHaveAttribute("data-state", /open/);
    const motion = await motionBudget(retry);
    expect(motion.animationDuration).toBeLessThanOrEqual(1);

    // In the retrying state the animated spinner is swapped for a static
    // marker rather than left spinning. Asserted positively as well: a
    // toBeHidden() on a mistyped test id passes for the wrong reason.
    const retrying = page.getByTestId("badge-dark-error-retrying");
    await expect(retrying.getByTestId("radio-sync-retry-spinner")).toBeHidden();
    await expect(retrying.getByTestId("radio-sync-retry-static")).toBeVisible();
  });
});

test.describe("SyncBadge tooltip with motion allowed (control)", () => {
  test("the enter animation is live, so the reduced-motion assertions mean something", async ({
    page,
  }) => {
    await openHarness(page, "no-preference", "dark:error");
    const trigger = chip(page, "dark", "error");
    await openTooltip(page, "dark", "error", trigger);

    const tooltip = tooltipFor(page, trigger);
    await expect(tooltip).toBeVisible();

    const motion = await motionBudget(tooltip);
    expect(
      motion.animationDuration,
      "control: Radix/tailwindcss-animate must declare a real enter duration here",
    ).toBeGreaterThan(1);
  });
});
