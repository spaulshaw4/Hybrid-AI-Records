import { test, expect, type Page } from "@playwright/test";
import { waitForHarnessHydrated } from "./helpers/sync-badge-aria";

/**
 * Visual regression for keyboard-only journeys through the sync badge.
 *
 * Everything here is driven with the keyboard alone — no mouse, no
 * locator.focus() shortcut — because the point is to prove the real tab order
 * reaches the badge and its Retry button, that the tooltip opens on focus,
 * that Enter/Space actually fire Retry, and that Escape dismisses the tooltip
 * while focus stays put.
 */

const HARNESS = "/dev/sync-badge";
const SHOT = { animations: "disabled", maxDiffPixelRatio: 0.01 } as const;

test.use({ timezoneId: "UTC" });

async function openHarness(page: Page) {
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await waitForHarnessHydrated(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}


const badge = (page: Page, id: string) => page.getByTestId(`badge-dark-${id}`);

/** What the browser currently has focused, described the way a test can assert it. */
function activeDescriptor(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { testid: null as string | null, tag: "body", badge: null as string | null };
    return {
      testid: el.getAttribute("data-testid"),
      tag: el.tagName.toLowerCase(),
      badge: el.closest("[data-testid^='badge-']")?.getAttribute("data-testid") ?? null,
    };
  });
}

/**
 * Tab forward until the focused element carries `testid`. Returns the number of
 * presses it took, so a regression that buries the badge behind new stops or
 * removes it from the tab order fails loudly instead of timing out.
 */
async function tabTo(page: Page, testid: string, max = 40) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    const active = await activeDescriptor(page);
    if (active.testid === testid) return i;
  }
  throw new Error(`Never reached [data-testid="${testid}"] after ${max} Tab presses`);
}

/**
 * The visible Radix popper, not the 1px visually-hidden aria copy. A tooltip
 * that is mid-close still occupies the DOM for a tick, so filter to visible
 * nodes and, when the caller knows the copy, to the matching one.
 */
const popper = (page: Page, hasText?: string | RegExp) => {
  const base = page.locator("[data-radix-popper-content-wrapper]:visible");
  return (hasText ? base.filter({ hasText }) : base).last();
};

/**
 * Clip a page screenshot to a locator so a moving popper can't destabilise it.
 *
 * The box is re-resolved under a poll rather than read once: Radix re-renders
 * the popper as it settles into position, so a handle grabbed immediately after
 * `toBeVisible()` can already be detached and return a null box.
 */
async function shotAround(page: Page, target: ReturnType<typeof popper>, name: string, pad = 6) {
  let box: Awaited<ReturnType<typeof target.boundingBox>> = null;
  await expect
    .poll(async () => {
      box = await target.boundingBox().catch(() => null);
      return box ? box.width > 0 && box.height > 0 : false;
    }, { message: `popper for ${name} never reported a stable bounding box` })
    .toBe(true);

  const { x, y, width, height } = box!;
  const viewport = page.viewportSize() ?? { width: 1280, height: 1800 };
  const clipX = Math.max(0, Math.floor(x) - pad);
  const clipY = Math.max(0, Math.floor(y) - pad);
  await expect(page).toHaveScreenshot(name, {
    ...SHOT,
    clip: {
      x: clipX,
      y: clipY,
      width: Math.max(1, Math.min(Math.ceil(width) + pad * 2, viewport.width - clipX)),
      height: Math.max(1, Math.min(Math.ceil(height) + pad * 2, viewport.height - clipY)),
    },
  });
}


test.describe("SyncBadge keyboard-only navigation", () => {
  test("tabbing to the badge opens its tooltip", async ({ page }) => {
    await openHarness(page);

    // The first status chip in the DOM is the dark surface's "Synced" badge.
    const presses = await tabTo(page, "radio-sync-status");
    expect(presses).toBeLessThanOrEqual(3);

    const tooltip = popper(page);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Mix synced to listener@hybrid-ai-records.com");

    await shotAround(page, tooltip, "kbd-tooltip-open.png");
    // The focus ring must be visible on a keyboard-reached chip.
    await expect(badge(page, "synced")).toHaveScreenshot("kbd-focus-ring-status.png", SHOT);
  });

  test("Escape closes the tooltip and leaves focus on the badge", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-status");
    await expect(popper(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(popper(page)).toBeHidden();

    // Escape dismisses the tooltip only — focus must not be thrown to <body>,
    // or a keyboard user loses their place in the page.
    expect(await activeDescriptor(page)).toEqual({
      testid: "radio-sync-status",
      tag: "span",
      badge: "badge-dark-synced",
    });
    await expect(badge(page, "synced")).toHaveScreenshot("kbd-escape-closed.png", SHOT);
  });

  test("tabbing reaches Retry inside the failed badge and Enter activates it", async ({ page }) => {
    await openHarness(page);

    const failed = badge(page, "error");
    await failed.scrollIntoViewIfNeeded();
    // Walk the real tab order into the failed badge: its chip, then its Retry.
    await tabTo(page, "radio-sync-retry");

    await expect(popper(page)).toBeVisible();
    await shotAround(page, popper(page), "kbd-retry-focused-tooltip.png");
    await expect(failed).toHaveScreenshot("kbd-focus-ring-retry.png", SHOT);

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("retry-count-dark-error")).toHaveText("Retry fired 1");
    // Activating Retry swaps the button into its disabled "Retrying" state.
    await expect(failed.getByTestId("radio-sync-retry")).toHaveAttribute("aria-disabled", "true");
    await expect(failed).toHaveScreenshot("kbd-retry-activated.png", SHOT);
  });

  test("Space also activates Retry from the keyboard", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-retry");

    await page.keyboard.press("Space");
    await expect(page.getByTestId("retry-count-dark-error")).toHaveText("Retry fired 1");
    await expect(badge(page, "error")).toHaveScreenshot("kbd-retry-activated-space.png", SHOT);
  });

  test("Escape from the Retry button closes the tooltip without losing focus", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-retry");
    await expect(popper(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(popper(page)).toBeHidden();
    expect(await activeDescriptor(page)).toEqual({
      testid: "radio-sync-retry",
      tag: "button",
      badge: "badge-dark-error",
    });

    // Retry must still work after the tooltip has been dismissed.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("retry-count-dark-error")).toHaveText("Retry fired 1");
    await expect(badge(page, "error")).toHaveScreenshot("kbd-escape-then-retry.png", SHOT);
  });

  test("shift-tabbing out of Retry lands back on the failed badge chip", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-retry");

    await page.keyboard.press("Shift+Tab");
    // Back onto the failed badge's own chip — not the previous badge in the list.
    expect(await activeDescriptor(page)).toEqual({
      testid: "radio-sync-status",
      tag: "span",
      badge: "badge-dark-error",
    });

    // Radix treats the move out of the nested button as leaving the trigger, so
    // the tooltip dismisses. Assert that against this badge's own trigger state
    // rather than a page-wide popper lookup: poppers are portalled to the body,
    // so a global ":visible" query can pick up an unrelated badge's tooltip and
    // fail for the wrong reason.
    await expect(badge(page, "error").getByTestId("radio-sync-error-cluster")).toHaveAttribute(
      "data-state",
      "closed",
    );
    await expect(popper(page, "Couldn't compare playback timestamps")).toHaveCount(0);
    // What must survive the move is the visible focus ring on the chip.
    await expect(badge(page, "error")).toHaveScreenshot("kbd-shift-tab-focus-ring.png", SHOT);

  });

});
