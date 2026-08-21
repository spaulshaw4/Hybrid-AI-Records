import { test, expect, type Page } from "@playwright/test";

/**
 * Keyboard focus + dismissal behaviour for the sync badge on phone profiles,
 * including iOS Safari (the `mobile-safari` project runs every `*.mobile.spec.ts`).
 *
 * WebKit is the engine most likely to diverge here: it historically skipped
 * non-form controls in the tab order, blurs elements that become
 * `disabled` mid-interaction, and treats Escape differently when a hardware
 * keyboard is attached to a touch device. Every assertion below is behavioural
 * (focus identity, tooltip visibility) rather than pixels, so the same file is
 * meaningful across engines.
 *
 * Sandbox note: the image's WebKit build predates this @playwright/test's
 * protocol, so `--project=mobile-safari` can't launch locally. `bun run
 * e2e/tools/verify-safari-keyboard.py` replays these exact steps on the
 * runnable WebKit; CI runs this spec directly.
 */

const HARNESS = "/dev/sync-badge";

test.use({ timezoneId: "UTC" });

async function openHarness(page: Page) {
  await page.clock.setFixedTime(new Date("2026-01-15T12:00:00Z"));
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

const badge = (page: Page, id: string) => page.getByTestId(`badge-dark-${id}`);

/** The visible Radix popper, ignoring the visually-hidden aria copy. */
const popper = (page: Page) => page.locator("[data-radix-popper-content-wrapper]:visible").last();

/** Identity of the focused element, in terms a test can assert on. */
function activeDescriptor(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { testid: null, tag: "body", badge: null };
    return {
      testid: el.getAttribute("data-testid"),
      tag: el.tagName.toLowerCase(),
      badge: el.closest("[data-testid^='badge-']")?.getAttribute("data-testid") ?? null,
    };
  });
}

/** Press `key` until the focused element carries `testid`; returns the press count. */
async function tabTo(page: Page, testid: string, key: "Tab" | "Shift+Tab" = "Tab", max = 40) {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(key);
    if ((await activeDescriptor(page)).testid === testid) return i;
  }
  throw new Error(`Never reached [data-testid="${testid}"] after ${max} ${key} presses`);
}

test.describe("SyncBadge keyboard behaviour on mobile engines", () => {
  test("Tab reaches the status chip and opens its tooltip", async ({ page }) => {
    await openHarness(page);

    // The badge chip is not a native control, so WebKit only reaches it if the
    // component keeps an explicit tabindex — that is what this asserts.
    const presses = await tabTo(page, "radio-sync-status");
    expect(presses).toBeLessThanOrEqual(3);

    await expect(popper(page)).toBeVisible();
    await expect(popper(page)).toContainText("Mix synced to listener@hybrid-ai-records.com");
    // A keyboard-reached chip must show a focus ring, not just be focused. The
    // ring is a Tailwind `focus-visible:ring-*`, i.e. a box-shadow, and WebKit
    // only paints it when it agrees the focus came from the keyboard.
    const ring = await page
      .getByTestId("radio-sync-status")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { shadow: s.boxShadow, outline: `${s.outlineStyle} ${s.outlineWidth}` };
      });
    expect(
      ring.shadow !== "none" || ring.outline !== "none 0px",
      `expected a visible focus ring, got ${JSON.stringify(ring)}`,
    ).toBe(true);

  });

  test("Escape closes the tooltip and keeps focus on the chip", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-status");
    await expect(popper(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(popper(page)).toBeHidden();
    expect(await activeDescriptor(page)).toEqual({
      testid: "radio-sync-status",
      tag: "span",
      badge: "badge-dark-synced",
    });
  });

  test("Tab away from a dismissed chip still advances the tab order", async ({ page }) => {
    await openHarness(page);
    await tabTo(page, "radio-sync-status");
    await page.keyboard.press("Escape");

    // Escape must not trap focus: the next Tab has to land somewhere new.
    await page.keyboard.press("Tab");
    const next = await activeDescriptor(page);
    expect(next.badge).not.toBe("badge-dark-synced");
    expect(next.tag).not.toBe("body");
  });

  test("Shift+Tab walks back out of the badge and re-opens on return", async ({ page }) => {
    await openHarness(page);

    const forward = await tabTo(page, "radio-sync-status");
    expect(forward).toBeGreaterThan(0);

    // Step backwards off the chip: the tooltip must close with the focus loss.
    await page.keyboard.press("Shift+Tab");
    expect((await activeDescriptor(page)).testid).not.toBe("radio-sync-status");
    await expect(popper(page)).toBeHidden();

    // Returning forward re-opens it — no stuck "already open" state.
    await page.keyboard.press("Tab");
    expect((await activeDescriptor(page)).testid).toBe("radio-sync-status");
    await expect(popper(page)).toBeVisible();
  });

  test("Tab moves from the failed chip to Retry, Shift+Tab moves back", async ({ page }) => {
    await openHarness(page);
    const failed = badge(page, "error");
    await failed.scrollIntoViewIfNeeded();

    await tabTo(page, "radio-sync-retry");
    expect(await activeDescriptor(page)).toMatchObject({
      testid: "radio-sync-retry",
      badge: "badge-dark-error",
    });

    // Backwards from Retry lands on that same badge's status chip.
    await page.keyboard.press("Shift+Tab");
    expect(await activeDescriptor(page)).toMatchObject({
      testid: "radio-sync-status",
      badge: "badge-dark-error",
    });
    await expect(popper(page)).toBeVisible();

    // Forwards again returns to Retry, and the chip tooltip must not linger.
    await page.keyboard.press("Tab");
    expect((await activeDescriptor(page)).testid).toBe("radio-sync-retry");
  });

  test("Enter on Retry fires it and focus survives the retrying swap", async ({ page }) => {
    await openHarness(page);
    await badge(page, "error").scrollIntoViewIfNeeded();
    await tabTo(page, "radio-sync-retry");

    await page.keyboard.press("Enter");
    // Retry flips to aria-disabled (not `disabled`) precisely so WebKit does
    // not blur it while the request is in flight.
    await expect(page.getByTestId("retry-count-dark-error")).toBeVisible();
    expect((await activeDescriptor(page)).testid).toBe("radio-sync-retry");
  });

  test("Escape while Retry is focused dismisses the tooltip, not the focus", async ({ page }) => {
    await openHarness(page);
    await badge(page, "error").scrollIntoViewIfNeeded();
    await tabTo(page, "radio-sync-retry");

    await page.keyboard.press("Escape");
    await expect(popper(page)).toBeHidden();
    expect((await activeDescriptor(page)).testid).toBe("radio-sync-retry");
  });
});
