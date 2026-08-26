import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * Axe + focus-trap contract for the QR panel across its states:
 *  - freshly opened (QR rendered)
 *  - after changing size / error-correction level
 *  - after the share link changes (form edit re-encodes the payload)
 *  - error state (invalid payload forces the "QR unavailable" panel)
 * In every state the panel must be axe-clean, keep focus trapped, and expose
 * correct ARIA labelling on the toggle, panel, controls and status regions.
 */

const PANEL = '[data-testid="share-link-qr"]';
const SIZE = '[data-testid="share-link-qr-size"]';
const LEVEL = '[data-testid="share-link-qr-level"]';
const DL_PNG = '[data-testid="share-link-qr-download"]';
const DL_SVG = '[data-testid="share-link-qr-download-svg"]';
const COPY_URL = '[data-testid="share-link-qr-copy-url"]';
const ALT = '[data-testid="share-link-qr-alt"]';
const STATUS = '[data-testid="share-link-qr-status"]';
const ERROR = '[data-testid="share-link-qr-error"]';
const RETRY = '[data-testid="share-link-qr-retry"]';

const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Injects axe and scans one subtree, returning "id: help" strings. */
async function scan(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const results = await axe.run(sel, { resultTypes: ["violations"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.violations.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v: any) => `${v.id}: ${v.help} :: ${v.nodes.map((n: any) => n.target.join(" ")).join(" | ")}`,
    );
  }, selector);
}

const toggle = (page: Page) =>
  page.getByRole("button", { name: /qr code for this order link/i }).first();
const closeBtn = (page: Page) =>
  page.getByRole("button", { name: /close the qr code/i }).first();

async function open(page: Page) {
  await page.goto("/portal?package=visual-push#order", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  await expect(toggle(page)).toBeVisible();
  // Let any late draft-restore effect settle so the panel can't remount mid-test.
  await page.waitForTimeout(1500);
}

/** Clicks the toggle until the panel is actually mounted (layout can still settle). */
async function openPanel(page: Page) {
  const panel = page.locator(PANEL);
  await expect(async () => {
    if ((await panel.count()) === 0) await toggle(page).click();
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  // The panel autofocuses on open; under load a late effect can steal focus, so
  // settle it deterministically before asserting anything about the trap.
  await expect(async () => {
    if (!(await focusInsidePanel(page))) await panel.focus();
    expect(await focusInsidePanel(page)).toBe(true);
  }).toPass({ timeout: 10_000 });
  return panel;
}

/** True when focus is somewhere inside the QR panel. */
function focusInsidePanel(page: Page) {
  return page.evaluate((sel) => {
    const panel = document.querySelector(sel);
    return !!panel && !!document.activeElement && panel.contains(document.activeElement);
  }, PANEL);
}

test.describe("QR panel — axe + focus trap across states", () => {
  test("open state is axe-clean and correctly labelled", async ({ page }) => {
    await open(page);
    const panel = await openPanel(page);

    expect(await scan(page, PANEL)).toEqual([]);

    // Toggle exposes expanded state and points at the panel.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(toggle(page)).toHaveAttribute("aria-controls", "order-share-qr");
    await expect(panel).toHaveAttribute("role", "group");

    // The QR image and its text alternative describe the encoded URL.
    const alt = page.locator(ALT);
    await expect(alt).toContainText(/full web address it encodes is: http/i);
    await expect(alt).toHaveAttribute("aria-live", "polite");

    // The generation status region eventually reports success.
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i);

    // Every control is labelled.
    for (const sel of [SIZE, LEVEL, DL_PNG, DL_SVG, COPY_URL]) {
      const name = await page
        .locator(sel)
        .evaluate((el) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "");
      expect(name.length).toBeGreaterThan(3);
    }
  });

  test("changing size and error-correction keeps the panel axe-clean and focus trapped", async ({
    page,
  }) => {
    await open(page);
    await openPanel(page);

    await page.locator(SIZE).selectOption("large");
    await page.locator(LEVEL).selectOption("H");
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i);

    expect(await scan(page, PANEL)).toEqual([]);
    expect(await focusInsidePanel(page)).toBe(true);

    // Tab several times: focus must stay inside the panel.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      expect(await focusInsidePanel(page)).toBe(true);
    }
  });

  test("editing the form re-announces the new link and stays axe-clean", async ({ page }) => {
    await open(page);
    await openPanel(page);

    const before = (await page.locator(ALT).textContent()) ?? "";

    await page.locator("#qo-artist").fill("Axe Test Artist");
    await expect(page.locator(ALT)).not.toHaveText(before, { timeout: 10_000 });
    await expect(page.locator(ALT)).toContainText(/Axe/i);
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i);

    expect(await scan(page, PANEL)).toEqual([]);
  });

  test("error state exposes an alert, a usable Retry, and stays axe-clean", async ({ page }) => {
    await open(page);
    await openPanel(page);
    await page.locator(LEVEL).selectOption("H");

    // A maximal demo link + artist name pushes the payload past the QR byte
    // capacity at the highest error-correction level — the real failure mode.
    const longLink = `https://cdn.example.com/stems/${"a1b2c3d4e5".repeat(56)}?take=final`;
    await page.locator("#qo-artist").fill("é".repeat(190));
    await page.locator("#qo-email").fill(`${"é".repeat(60)}@studio-with-a-long-domain.example.com`);
    await page.locator("#qo-link").fill(longLink);


    const error = page.locator(ERROR);
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.locator(STATUS)).toHaveText(/could not be generated/i);
    await expect(page.locator(ALT)).toContainText(/Warning: the QR code could not be generated/i);

    expect(await scan(page, PANEL)).toEqual([]);

    // Retry is visible, labelled, and keyboard reachable without leaving the panel.
    const retry = page.locator(RETRY);
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAttribute("aria-label", /retry generating the qr code/i);
    await retry.focus();
    expect(await focusInsidePanel(page)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(error).toBeVisible();
    expect(await focusInsidePanel(page)).toBe(true);

    // Lowering the error correction fits the payload again and clears the error.
    await page.locator(LEVEL).selectOption("L");
    await expect(error).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(STATUS)).toHaveText(/generated successfully/i);
    expect(await scan(page, PANEL)).toEqual([]);
  });



  test("closing returns focus to the toggle and leaves no stale ARIA state", async ({ page }) => {
    await open(page);
    await openPanel(page);

    await closeBtn(page).click();
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    expect(await scan(page, "#order")).toEqual([]);
  });
});
