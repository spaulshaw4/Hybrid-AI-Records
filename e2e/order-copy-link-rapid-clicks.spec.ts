import { expect, test, type Page } from "@playwright/test";

/**
 * Impatient users double- and triple-click "Copy Share Link". Each click must
 * copy once and announce once: the polite live region stays a single node with
 * a single message, focus never leaves the button, the toast layer doesn't
 * grow unbounded, and the "Link Copied" confirmation still reverts on its own
 * (one timer, not a pile of competing ones).
 */

const PACKAGE_SELECT = "#qo-package";
const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const liveRegion = (page: Page) => copyButton(page).locator("span[aria-live='polite']");
const toasts = (page: Page) => page.locator("[data-sonner-toast]");

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  await page.waitForTimeout(1500);
}

/** Fires `count` clicks back to back with no waiting in between. */
async function rapidClicks(page: Page, count: number, delay = 0) {
  const btn = copyButton(page);
  await btn.scrollIntoViewIfNeeded();
  for (let i = 0; i < count; i += 1) {
    await btn.click({ delay: 0, noWaitAfter: true });
    if (delay) await page.waitForTimeout(delay);
  }
}

/** Selects a package explicitly so late draft restoration can't win the race. */
async function ensureTier(page: Page, label: string) {
  const select = page.locator(PACKAGE_SELECT);
  await expect(async () => {
    await select.selectOption({ label });
    await page.waitForTimeout(400);
    await expect(select).toHaveValue(label, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

/** Counts how many elements on the page expose a polite live region. */
const politeRegions = (page: Page) => page.locator("[aria-live='polite']");

test.describe("rapid Copy Link clicks", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("five fast clicks announce success once, with focus and live region intact", async ({
    page,
  }) => {
    test.slow();
    await open(page, "/?package=visual-push#order");

    const baselineRegions = await politeRegions(page).count();

    await expect(async () => {
      await rapidClicks(page, 5);
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
      // 2. Focus stays on the button the user is hammering.
      await expect(copyButton(page)).toBeFocused({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });

    // 1. Exactly one live region on the button, holding exactly one message.
    await expect(liveRegion(page)).toHaveCount(1);
    await expect(liveRegion(page)).toHaveText("Share link copied to clipboard");
    // The only region the burst may add is the toaster's own announcer — the
    // extra clicks never spawned duplicate announcer nodes per click.
    expect(await politeRegions(page).count()).toBeLessThanOrEqual(baselineRegions + 2);

    // 3. The clipboard holds the one correct URL.
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const url = new URL(copied);
    expect(url.searchParams.get("package")).toBe("visual-push");
    expect(url.hash).toBe("#order");

    // 4. At most one toast per click — bounded, never a runaway stack.
    const visible = await toasts(page).count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThanOrEqual(5);
    await expect(toasts(page).first()).toContainText("Share link copied");

    // 5. Nothing degraded into the manual-copy fallback.
    await expect(page.locator('[data-testid="share-link-fallback"]')).toHaveCount(0);
  });

  test("the confirmation still clears itself after the burst", async ({ page }) => {
    test.slow();
    await open(page, "/#order");

    await expect(async () => {
      await rapidClicks(page, 4, 60);
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    }).toPass({ timeout: 20_000 });

    // One timer wins: the label reverts and the live region empties.
    await expect(copyButton(page)).toContainText(/copy share link/i, { timeout: 10_000 });
    await expect(liveRegion(page)).toHaveText("");

    // No flapping afterwards — the state stays settled.
    await page.waitForTimeout(1500);
    await expect(copyButton(page)).toContainText(/copy share link/i);

    // Toasts auto-dismiss rather than accumulating.
    await expect(toasts(page)).toHaveCount(0, { timeout: 15_000 });
  });

  test("keyboard repeat (Enter held) behaves like a single confirmed copy", async ({ page }) => {
    test.slow();
    await open(page, "/?package=full-label#order");
    await ensureTier(page, "Full Label Release");

    await expect(async () => {
      // Re-assert the tier each attempt: a late draft restore can flip the
      // select between attempts and change the URL that gets copied.
      await ensureTier(page, "Full Label Release");
      await copyButton(page).focus();
      for (let i = 0; i < 5; i += 1) await page.keyboard.press("Enter");
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
      await expect(copyButton(page)).toBeFocused({ timeout: 2000 });
      const url = await page.evaluate(() => navigator.clipboard.readText());
      expect(new URL(url).searchParams.get("package")).toBe("full-label");
    }).toPass({ timeout: 30_000 });
    await expect(liveRegion(page)).toHaveCount(1);
    await expect(liveRegion(page)).toHaveText("Share link copied to clipboard");


    const visible = await toasts(page).count();
    expect(visible).toBeLessThanOrEqual(5);
  });

  test("a burst mid-edit copies the latest values without duplicate announcements", async ({
    page,
  }) => {
    test.slow();
    await open(page, "/#order");

    await expect(async () => {
      await page.locator("#qo-artist").fill("");
      await page.locator("#qo-artist").click();
      await page.keyboard.type("Rapid Fire", { delay: 10 });
      await expect(page.locator("#qo-artist")).toHaveValue("Rapid Fire", { timeout: 2000 });
      await page.waitForTimeout(600);
      await rapidClicks(page, 3);
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(new URL(copied).searchParams.get("artist")).toBe("Rapid Fire");
    }).toPass({ timeout: 60_000 });

    await expect(liveRegion(page)).toHaveCount(1);
    await expect(liveRegion(page)).toHaveText("Share link copied to clipboard");
    // Bounded: one toast per click, even across retried bursts.
    expect(await toasts(page).count()).toBeLessThanOrEqual(12);
  });
});
