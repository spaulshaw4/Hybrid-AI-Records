import { expect, test, type Page } from "@playwright/test";
import jsQR from "jsqr";

/**
 * The QR code is only trustworthy if scanning it lands on exactly the same URL
 * the Copy button puts on the clipboard — utm_* params included — and if it
 * re-encodes live while the artist keeps editing the form.
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";

const LABELS = {
  "distribution-release": "Distribution & Release",
  "visual-push": "Production & Visual Push",
  "full-label": "Full Label Release",
} as const;

type Slug = keyof typeof LABELS;

const UTM = {
  utm_source: "qr-flyer",
  utm_medium: "print",
  utm_campaign: "fall_tour 2026",
  utm_content: "backstage-poster",
  utm_term: "hybrid ai records",
};

const utmQuery = new URLSearchParams(UTM).toString();

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const qrToggle = (page: Page) => page.getByRole("button", { name: /QR code for this order link/i });
const qrPanel = (page: Page) => page.getByTestId("share-link-qr");
const qrUrlText = (page: Page) => page.getByTestId("share-link-qr-url");

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle before typing.
  await page.waitForTimeout(2000);
}

async function chooseTier(page: Page, slug: Slug) {
  await expect(async () => {
    await page.selectOption(PACKAGE_SELECT, LABELS[slug]);
    expect(new URL(page.url()).searchParams.get("package")).toBe(slug);
  }).toPass({ timeout: 20_000 });
}

async function typeInto(page: Page, selector: string, value: string) {
  await expect(async () => {
    await page.locator(selector).fill("");
    await page.locator(selector).click();
    await page.keyboard.type(value, { delay: 10 });
    await expect(page.locator(selector)).toHaveValue(value, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
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
 * Pull the off-screen high-res QR canvas out of the page as downscaled
 * grayscale bytes, then decode it in Node with a real QR reader.
 */
async function decodeQr(page: Page): Promise<string> {
  const SIZE = 512;
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
    for (let i = 0; i < data.length; i += 4) {
      binary += String.fromCharCode(data[i]!);
    }
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
  expect(decoded, "QR code decodes").toBeTruthy();
  return decoded!.data;
}

async function copyLink(page: Page): Promise<string> {
  let copied = "";
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^https?:\/\//);
  }).toPass({ timeout: 15_000 });
  return copied;
}

function expectSameUrl(a: string, b: string) {
  const left = new URL(a);
  const right = new URL(b);
  expect(left.origin + left.pathname).toBe(right.origin + right.pathname);
  expect(left.hash).toBe(right.hash);
  expect([...left.searchParams.entries()].sort()).toEqual(
    [...right.searchParams.entries()].sort(),
  );
}

test.describe("QR payload matches the share URL", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("the encoded QR payload equals the copied link, utm_* included", async ({ page }) => {
    test.slow();

    await open(page, `/?${utmQuery}#order`);
    await chooseTier(page, "visual-push");
    await typeInto(page, ARTIST, "Ash & Anvil");
    await typeInto(page, EMAIL, "studio+qr@ash-anvil.example");
    await showQr(page);

    const copied = await copyLink(page);

    let decoded = "";
    await expect(async () => {
      decoded = await decodeQr(page);
      expectSameUrl(decoded, copied);
    }).toPass({ timeout: 30_000 });

    const params = new URL(decoded).searchParams;
    expect(params.get("package")).toBe("visual-push");
    expect(params.get("artist")).toBe("Ash & Anvil");
    expect(params.get("email")).toBe("studio+qr@ash-anvil.example");
    for (const [key, value] of Object.entries(UTM)) {
      expect(params.get(key), `${key} encoded in QR`).toBe(value);
    }

    // The human-readable caption under the QR shows the very same URL.
    expectSameUrl((await qrUrlText(page).innerText()).trim(), decoded);
  });

  test("the QR payload re-encodes live as the tier and details change", async ({ page }) => {
    test.slow();

    await open(page, `/?package=distribution-release&${utmQuery}#order`);
    await showQr(page);

    await expect(async () => {
      const first = new URL(await decodeQr(page));
      expect(first.searchParams.get("package")).toBe("distribution-release");
    }).toPass({ timeout: 30_000 });

    await chooseTier(page, "full-label");
    await typeInto(page, ARTIST, "Nightfall Choir");

    let updated = "";
    await expect(async () => {
      updated = await decodeQr(page);
      const params = new URL(updated).searchParams;
      expect(params.get("package")).toBe("full-label");
      expect(params.get("artist")).toBe("Nightfall Choir");
    }).toPass({ timeout: 40_000 });

    // Editing must never drop the campaign attribution from the QR payload.
    for (const [key, value] of Object.entries(UTM)) {
      expect(new URL(updated).searchParams.get(key), `${key} after edits`).toBe(value);
    }

    // And the live payload still matches what Copy puts on the clipboard.
    const copied = await copyLink(page);
    await expect(async () => {
      expectSameUrl(await decodeQr(page), copied);
    }).toPass({ timeout: 30_000 });
  });
});
