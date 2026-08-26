import { expect, test, type Page } from "@playwright/test";

/**
 * The QR status live region must narrate the full generation lifecycle:
 * "Generating QR code…" → "QR code generated successfully for <url>" → and on
 * failure "QR code could not be generated. <details>", re-announcing whenever
 * the share link changes or a Retry is attempted. The "generating" phase is
 * short-lived, so a MutationObserver records every text the region ever held
 * rather than polling for it.
 */

const PANEL = '[data-testid="share-link-qr"]';
const STATUS = '[data-testid="share-link-qr-status"]';
const LEVEL = '[data-testid="share-link-qr-level"]';
const SIZE = '[data-testid="share-link-qr-size"]';
const ERROR = '[data-testid="share-link-qr-error"]';
const RETRY = '[data-testid="share-link-qr-retry"]';

const toggle = (page: Page) =>
  page.getByRole("button", { name: /qr code for this order link/i }).first();

async function open(page: Page) {
  await page.goto("/portal?package=visual-push#order", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  await expect(toggle(page)).toBeVisible();
  // Let late draft restoration settle so the panel can't remount mid-test.
  await page.waitForTimeout(1500);
}

async function openPanel(page: Page) {
  const panel = page.locator(PANEL);
  await expect(async () => {
    if ((await panel.count()) === 0) await toggle(page).click();
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return panel;
}

/**
 * Records every distinct value the live region takes, including transient ones
 * a poll-based assertion would miss. Survives the region unmounting/remounting.
 */
async function recordStatus(page: Page) {
  await page.evaluate((sel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__qrStatusLog = [] as string[];
    const push = () => {
      const el = document.querySelector(sel);
      const text = (el?.textContent ?? "").trim();
      const log = w.__qrStatusLog as string[];
      if (text && log[log.length - 1] !== text) log.push(text);
    };
    w.__qrStatusObserver?.disconnect();
    const obs = new MutationObserver(push);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    w.__qrStatusObserver = obs;
    push();
  }, STATUS);
}

function statusLog(page: Page): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => ((window as any).__qrStatusLog ?? []) as string[]);
}

/** Waits until the recorded log contains a match. */
async function expectAnnounced(page: Page, re: RegExp) {
  await expect
    .poll(async () => (await statusLog(page)).some((s) => re.test(s)), { timeout: 15_000 })
    .toBe(true);
}

/** Fills the form with a payload too large to encode at level H. */
async function forceFailure(page: Page) {
  await page.locator(LEVEL).selectOption("H");
  const longLink = `https://cdn.example.com/stems/${"a1b2c3d4e5".repeat(56)}?take=final`;
  await page.locator("#qo-artist").fill("é".repeat(190));
  await page.locator("#qo-email").fill(`${"é".repeat(60)}@studio-with-a-long-domain.example.com`);
  await page.locator("#qo-link").fill(longLink);
  await expect(page.locator(ERROR)).toBeVisible({ timeout: 15_000 });
}

test.describe("QR aria-live status announcements", () => {
  test("region is a polite, atomic status that is empty before the panel opens", async ({
    page,
  }) => {
    await open(page);
    const status = page.locator(STATUS);
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText("");
  });

  test("opening the panel announces generating, then success with the encoded URL", async ({
    page,
  }) => {
    await open(page);
    await recordStatus(page);
    await openPanel(page);

    await expectAnnounced(page, /generating qr code/i);
    await expectAnnounced(page, /qr code generated successfully for https?:\/\//i);

    // The success message names the exact URL the QR encodes.
    const success = (await statusLog(page)).find((s) => /generated successfully/i.test(s))!;
    const announcedUrl = success.replace(/^.*successfully for /i, "");
    const encoded = await page.locator('[data-testid="share-link-qr-alt"]').textContent();
    expect(encoded).toContain(announcedUrl);

    // Order matters: generating must precede success.
    const log = await statusLog(page);
    expect(log.findIndex((s) => /generating/i.test(s))).toBeLessThan(
      log.findIndex((s) => /generated successfully/i.test(s)),
    );
  });

  test("changing the share link re-announces generating then the new success text", async ({
    page,
  }) => {
    await open(page);
    await openPanel(page);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i, { timeout: 15_000 });

    await recordStatus(page);
    await page.locator("#qo-artist").fill("Live Region Artist");

    await expectAnnounced(page, /generating qr code/i);
    // The new success text names the updated link (artist is URL-encoded).
    await expectAnnounced(page, /generated successfully for .*Live.{0,3}Region/i);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i);
  });

  test("changing size or error-correction re-announces the lifecycle", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i, { timeout: 15_000 });

    await recordStatus(page);
    await page.locator(SIZE).selectOption("large");
    await expectAnnounced(page, /generating qr code/i);
    await expectAnnounced(page, /generated successfully/i);

    await recordStatus(page);
    await page.locator(LEVEL).selectOption("Q");
    await expectAnnounced(page, /generating qr code/i);
    await expectAnnounced(page, /generated successfully/i);
  });

  test("a payload that cannot be encoded announces the failure with details", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i, { timeout: 15_000 });

    await recordStatus(page);
    await forceFailure(page);

    await expectAnnounced(page, /qr code could not be generated\./i);
    const failure = (await statusLog(page)).find((s) => /could not be generated/i.test(s))!;
    // The announcement carries actionable detail, not just the bare headline.
    expect(failure.replace(/^.*could not be generated\.\s*/i, "").length).toBeGreaterThan(10);
    await expect(page.locator(STATUS)).toHaveText(/could not be generated/i);
  });

  test("each Retry re-announces even when the failure is identical", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await forceFailure(page);

    await recordStatus(page);
    await page.locator(RETRY).click();
    await expectAnnounced(page, /retry 1: qr code could not be generated/i);
    await page.locator(RETRY).click();
    await expectAnnounced(page, /retry 2: qr code could not be generated/i);

    // Two distinct announcements, so a screen reader speaks both attempts.
    const log = await statusLog(page);
    expect(log.filter((s) => /^retry \d+: qr code could not be generated/i.test(s)).length)
      .toBeGreaterThanOrEqual(2);
  });

  test("recovering from failure announces success again", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await forceFailure(page);
    await expect(page.locator(STATUS)).toHaveText(/could not be generated/i);

    await recordStatus(page);
    await page.locator(LEVEL).selectOption("L");
    await expect(page.locator(ERROR)).toHaveCount(0, { timeout: 15_000 });

    await expectAnnounced(page, /generated successfully/i);
    await expect(page.locator(STATUS)).not.toHaveText(/could not be generated/i);
  });

  test("closing the panel clears the status so nothing stale is announced", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i, { timeout: 15_000 });

    await page.getByRole("button", { name: /close the qr code/i }).first().click();
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator(STATUS)).toHaveText("");
  });
});
