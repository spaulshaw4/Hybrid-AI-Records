import { test, expect, type Page, type Locator } from "@playwright/test";
import { waitForHarnessHydrated } from "./helpers/sync-badge-aria";

/**
 * The tooltip must stay anchored to the badge that opened it, at every mobile
 * width, in both themes.
 *
 * A popper is an overlay, so "does not overlap" can't mean "overlaps nothing" —
 * it is allowed to sit over inert body copy. What must never happen:
 *
 *   - it drifts away from its trigger (a tooltip pointing at nothing)
 *   - it covers the Retry button, hiding the one control the failure state offers
 *   - it covers page chrome below the console (the footer sentinel)
 *   - it spills outside the viewport, which at 320px is the usual failure
 *
 * Radix is free to flip sides when space runs out; that's correct behaviour, so
 * the assertions accept top *or* bottom placement and only require the popper to
 * stay tight against the trigger edge it chose.
 */

const HARNESS = "/dev/sync-badge";
const THEMES = ["dark", "light"] as const;
// 320 smallest supported, 360 common Android, 390 iPhone 14/15, 430 Pro Max.
const WIDTHS = [320, 360, 390, 430] as const;

/** Radix's offset plus the arrow; anything beyond this is drift, not spacing. */
const MAX_GAP = 16;
/** Sub-pixel tolerance for rect comparisons. */
const EPS = 1;

type Rect = { x: number; y: number; width: number; height: number };

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const centerX = (r: Rect) => r.x + r.width / 2;

/** True when two rects share any area (touching edges do not count). */
function overlaps(a: Rect, b: Rect) {
  return (
    a.x < right(b) - EPS && right(a) > b.x + EPS && a.y < bottom(b) - EPS && bottom(a) > b.y + EPS
  );
}

function describeRect(label: string, r: Rect) {
  return `${label} { x:${Math.round(r.x)} y:${Math.round(r.y)} w:${Math.round(r.width)} h:${Math.round(r.height)} }`;
}

async function openHarness(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await waitForHarnessHydrated(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** The visible popper wrapper — the painted tooltip, not the sr-only copy. */
const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]:visible").last();

/**
 * Opens the badge's tooltip via keyboard focus and returns the settled rects.
 * The popper animates into place, so poll until its box stops moving rather
 * than measuring the first frame.
 */
async function openTooltip(page: Page, badge: Locator) {
  await badge.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo({ top: window.scrollY, behavior: "instant" }));

  const trigger = badge.getByTestId("radio-sync-status");
  await trigger.focus();
  await expect(popper(page)).toHaveCount(1);

  let last: Rect | null = null;
  for (let i = 0; i < 20; i++) {
    const box = await popper(page).boundingBox();
    if (box && last && Math.abs(box.x - last.x) < 0.5 && Math.abs(box.y - last.y) < 0.5) {
      last = box;
      break;
    }
    last = box;
    await page.waitForTimeout(50);
  }
  expect(last, "tooltip never settled into a stable position").toBeTruthy();

  return { tip: last as Rect, triggerRect: (await trigger.boundingBox())! };
}

/** The tooltip hugs the trigger, on whichever side Radix chose. */
function expectAnchored(tip: Rect, triggerRect: Rect, viewport: { width: number }) {
  const below = tip.y >= bottom(triggerRect) - EPS;
  const above = bottom(tip) <= triggerRect.y + EPS;
  expect(
    below || above,
    `tooltip must sit above or below the trigger — ${describeRect("tip", tip)} ${describeRect("trigger", triggerRect)}`,
  ).toBe(true);

  const gap = below ? tip.y - bottom(triggerRect) : triggerRect.y - bottom(tip);
  expect(gap, `tooltip drifted ${Math.round(gap)}px from its trigger`).toBeLessThanOrEqual(MAX_GAP);
  expect(gap, "tooltip must not overlap its own trigger").toBeGreaterThanOrEqual(-EPS);

  // Horizontally it must still point at the trigger: either centred on it, or
  // clamped against a viewport edge (legitimate on a 320px screen) while still
  // spanning the trigger.
  const clamped = tip.x <= 2 || right(tip) >= viewport.width - 2;
  const centred = Math.abs(centerX(tip) - centerX(triggerRect)) <= tip.width / 2;
  const spansTrigger = tip.x <= centerX(triggerRect) && right(tip) >= centerX(triggerRect);
  expect(
    centred || (clamped && spansTrigger),
    `tooltip is not horizontally anchored — ${describeRect("tip", tip)} ${describeRect("trigger", triggerRect)}`,
  ).toBe(true);
}

/** Nothing may render outside the visual viewport. */
function expectInViewport(tip: Rect, viewport: { width: number; height: number }) {
  expect(tip.x, "tooltip spills off the left edge").toBeGreaterThanOrEqual(-EPS);
  expect(right(tip), "tooltip spills off the right edge").toBeLessThanOrEqual(viewport.width + EPS);
  expect(tip.y, "tooltip spills off the top edge").toBeGreaterThanOrEqual(-EPS);
  expect(bottom(tip), "tooltip spills off the bottom edge").toBeLessThanOrEqual(
    viewport.height + EPS,
  );
}

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    test.describe(`SyncBadge tooltip anchoring @${width}px (${theme})`, () => {
      test("stays pinned to its trigger and inside the viewport", async ({ page }) => {
        await openHarness(page, width);
        const viewport = page.viewportSize()!;

        const badge = page.getByTestId(`badge-${theme}-resolved`);
        const { tip, triggerRect } = await openTooltip(page, badge);

        expectAnchored(tip, triggerRect, viewport);
        expectInViewport(tip, viewport);
      });

      test("never covers the Retry button in the failed state", async ({ page }) => {
        await openHarness(page, width);
        const viewport = page.viewportSize()!;

        const badge = page.getByTestId(`badge-${theme}-error`);
        const { tip, triggerRect } = await openTooltip(page, badge);
        const retry = (await badge.getByTestId("radio-sync-retry").boundingBox())!;

        expectAnchored(tip, triggerRect, viewport);
        expectInViewport(tip, viewport);
        expect(
          overlaps(tip, retry),
          `tooltip covers Retry — ${describeRect("tip", tip)} ${describeRect("retry", retry)}`,
        ).toBe(false);

        // Covering it visually is one failure mode; the other is the browser
        // hit-testing the popper instead of the button. Prove the real click
        // target at Retry's centre is still Retry.
        const hit = await page.evaluate(
          ([x, y]) => {
            const el = document.elementFromPoint(x, y) as HTMLElement | null;
            return el?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
          },
          [retry.x + retry.width / 2, retry.y + retry.height / 2] as const,
        );
        expect(hit, "Retry is not the topmost element at its own centre").toBe("radio-sync-retry");
      });

      test("never covers the page footer", async ({ page }) => {
        await openHarness(page, width);
        const viewport = page.viewportSize()!;

        // The last badge on the page is the one whose tooltip could reach the
        // footer, so open that one rather than a mid-page badge.
        const badge = page.getByTestId(`badge-${theme}-error-retrying`);
        const { tip, triggerRect } = await openTooltip(page, badge);

        const footer = page.getByTestId("harness-footer");
        await expect(footer).toBeAttached();
        const footerRect = (await footer.boundingBox())!;

        expectAnchored(tip, triggerRect, viewport);
        expect(
          overlaps(tip, footerRect),
          `tooltip covers the footer — ${describeRect("tip", tip)} ${describeRect("footer", footerRect)}`,
        ).toBe(false);
      });
    });
  }
}
