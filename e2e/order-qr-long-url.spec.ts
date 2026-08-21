import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";

/**
 * Regression: a maximal share URL (long artist, long demo link, full utm_*
 * set) must still be encoded into the QR *in full*. The failure this guards
 * against is silent truncation — a QR that scans fine but drops the tail of
 * the query string, sending the artist to the wrong tier or losing attribution.
 */

const PACKAGE_SELECT = "#qo-package";
const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const qrToggle = (page: Page) => page.getByRole("button", { name: /QR code for this order link/i });
const qrPanel = (page: Page) => page.getByTestId("share-link-qr");
const qrUrlText = (page: Page) => page.getByTestId("share-link-qr-url");

const UTM = {
  utm_source: "tour-poster",
  utm_medium: "print",
  utm_campaign: "long_link_regression 2026",
  utm_content: "venue-wall-a3",
  utm_term: "hybrid ai records qr",
};
const utmQuery = new URLSearchParams(UTM).toString();

/** ~120 chars including reserved + unicode characters. */
const LONG_ARTIST = "Ärtîst & Co. / Studio #7 — Продакшн ".repeat(4).slice(0, 120).trim();
/** ~300 char https link (no whitespace so it passes link validation). */
const LONG_LINK = `https://cdn.example.com/stems/${"a1b2c3d4e5".repeat(30)}?take=final&mix=v12`.slice(
  0,
  300,
);
const LONG_EMAIL = `${"artist.longbox.name".repeat(2)}@studio-with-a-very-long-domain-name.example.com`;

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Draft restoration can land seconds after load and wipe the form.
  await page.waitForTimeout(4000);
}

async function fillLongValues(page: Page) {
  await expect(async () => {
    await page.locator("#qo-artist").fill(LONG_ARTIST);
    await page.locator("#qo-email").fill(LONG_EMAIL);
    await page.locator(PACKAGE_SELECT).selectOption({ label: "Production & Visual Push" });
    await page.locator("#qo-link").fill(LONG_LINK);
    // Long enough that a late draft restore would already have clobbered us.
    await page.waitForTimeout(3000);
    await expect(page.locator("#qo-artist")).toHaveValue(LONG_ARTIST, { timeout: 1500 });
    await expect(page.locator("#qo-link")).toHaveValue(LONG_LINK, { timeout: 1500 });
  }).toPass({ timeout: 45_000 });
}

async function showQr(page: Page) {
  await expect(async () => {
    const toggle = qrToggle(page);
    await toggle.scrollIntoViewIfNeeded();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(qrPanel(page)).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * Reads the off-screen high-resolution QR canvas as grayscale bytes and decodes
 * it in Node. Dense (high-version) codes need a generous sample size, so this
 * downscales to 768px — roughly 4px per module at the largest QR versions.
 */
async function decodeQr(page: Page): Promise<string> {
  const SIZE = 768;
  const payload = await page.evaluate((size) => {
    const source = document
      .querySelector('[data-testid="share-link-qr"]')
      ?.querySelector("canvas") as HTMLCanvasElement | null;
    if (!source) return null;

    const scratch = document.createElement("canvas");
    scratch.width = size;
    scratch.height = size;
    const ctx = scratch.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let binary = "";
    for (let i = 0; i < data.length; i += 4) binary += String.fromCharCode(data[i]!);
    return btoa(binary);
  }, SIZE);

  expect(payload, "QR canvas is present and readable").toBeTruthy();

  const gray = Buffer.from(payload!, "base64");
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i]!;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }

  const decoded = jsQR(rgba, SIZE, SIZE);
  expect(decoded, "long-URL QR code decodes").toBeTruthy();
  return decoded!.data;
}

async function copyLink(page: Page): Promise<string> {
  let copied = "";
  await expect(async () => {
    // A late draft restore can wipe the form after it was filled, so re-assert
    // the long values immediately before copying.
    await fillLongValues(page);
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^https?:\/\//);
    expect(copied.length).toBeGreaterThan(600);
  }).toPass({ timeout: 120_000 });
  return copied;
}

function expectSameUrl(actual: string, expected: string) {
  const a = new URL(actual);
  const b = new URL(expected);
  expect(a.origin + a.pathname).toBe(b.origin + b.pathname);
  expect(a.hash).toBe(b.hash);
  expect([...a.searchParams.entries()].sort()).toEqual([...b.searchParams.entries()].sort());
}

/** Every value round-trips intact — the tail of the query string included. */
function expectComplete(url: string) {
  const params = new URL(url).searchParams;
  expect(params.get("package")).toBe("visual-push");
  expect(params.get("artist")).toBe(LONG_ARTIST);
  expect(params.get("email")).toBe(LONG_EMAIL);
  expect(params.get("demo")).toBe(LONG_LINK);
  for (const [key, value] of Object.entries(UTM)) {
    expect(params.get(key), `${key} survives the long payload`).toBe(value);
  }
}

test.describe("long share URLs stay scannable and complete", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("a maximal URL encodes into the QR with no truncation", async ({ page }) => {
    test.slow();

    await open(page, `/?${utmQuery}#order`);
    await fillLongValues(page);
    await showQr(page);

    const copied = await copyLink(page);
    // Guard the guard: this only tests long URLs if the URL really is long.
    expect(copied.length).toBeGreaterThan(600);

    let decoded = "";
    await expect(async () => {
      decoded = await decodeQr(page);
      expectSameUrl(decoded, copied);
    }).toPass({ timeout: 45_000 });

    expectComplete(decoded);
    // Byte-for-byte: nothing was clipped, and no ellipsis crept in.
    expect(decoded.length).toBe(copied.length);
    expect(decoded).not.toContain("\u2026");
    expectSameUrl((await qrUrlText(page).innerText()).trim(), copied);
  });

  test("raising size and error correction keeps the full long payload", async ({ page }) => {
    test.slow();

    await open(page, `/?${utmQuery}#order`);
    await fillLongValues(page);
    await showQr(page);

    const copied = await copyLink(page);
    expect(copied.length).toBeGreaterThan(600);

    await page.getByTestId("share-link-qr-size").selectOption("large");
    await page.getByTestId("share-link-qr-level").selectOption("H");

    await expect(async () => {
      const decoded = await decodeQr(page);
      expectSameUrl(decoded, copied);
      expectComplete(decoded);
      expect(decoded.length).toBe(copied.length);
    }).toPass({ timeout: 45_000 });
  });
});
