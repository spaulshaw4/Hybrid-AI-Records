import { expect, type Page } from "@playwright/test";

/**
 * Helpers for the WebKit "frozen tile" regression suite.
 *
 * A frozen tile is a compositing failure, not a DOM failure: the markup is
 * fine but the GPU layer stops being rasterised, so the viewport (or a band of
 * it) renders as one flat colour. DOM assertions cannot see that, so we decode
 * a real screenshot inside the page and measure colour variety per tile.
 */

export type TileReport = {
  /** Number of 4x4 grid tiles that rendered a single flat colour. */
  flatTiles: number;
  /** Distinct colours across the whole viewport. */
  distinctColors: number;
};

/** Decode a screenshot in-page and measure per-tile colour variety. */
export async function measureTiles(page: Page): Promise<TileReport> {
  const shot = await page.screenshot({ type: "png" });
  const base64 = shot.toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const all = new Set<number>();
    let flatTiles = 0;
    const cols = 4;
    const rows = 4;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const tile = new Set<number>();
        const x0 = Math.floor((tx * canvas.width) / cols);
        const x1 = Math.floor(((tx + 1) * canvas.width) / cols);
        const y0 = Math.floor((ty * canvas.height) / rows);
        const y1 = Math.floor(((ty + 1) * canvas.height) / rows);
        for (let y = y0; y < y1; y += 4) {
          for (let x = x0; x < x1; x += 4) {
            const i = (y * canvas.width + x) * 4;
            const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
            tile.add(key);
            all.add(key);
          }
        }
        if (tile.size <= 1) flatTiles++;
      }
    }
    return { flatTiles, distinctColors: all.size };
  }, base64);
}

/** Assert the viewport still paints real content (no frozen/blank compositing). */
export async function expectNoFrozenTiles(page: Page, label: string) {
  const before = await measureTiles(page);
  // A frozen viewport keeps returning the exact same flat raster; require both
  // overall colour variety and that most tiles are not single-colour.
  expect(before.distinctColors, `${label}: viewport collapsed to a flat raster`).toBeGreaterThan(8);
  expect(before.flatTiles, `${label}: too many frozen (single-colour) tiles`).toBeLessThanOrEqual(8);
}

/**
 * Assert no overlay state leaked after closing (scroll lock, portals, guards).
 * Polls, because Radix keeps content mounted through its exit animation.
 */
export async function expectOverlayStateClean(page: Page, label: string) {
  const read = () =>
    page.evaluate(() => {
      const html = document.documentElement;
      const openPortals = Array.from(
        document.querySelectorAll("[data-radix-popper-content-wrapper], [role='dialog'], [role='listbox'], [role='menu']"),
      ).filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }).length;
      return {
        overlayOpen: html.getAttribute("data-overlay-open") === "true",
        bodyBlocked: getComputedStyle(document.body).pointerEvents === "none",
        scrollLocked: getComputedStyle(document.body).overflow === "hidden",
        openPortals,
      };
    });

  await expect
    .poll(async () => JSON.stringify(await read()), {
      timeout: 5_000,
      message: `${label}: overlay state did not settle after close`,
    })
    .toBe(JSON.stringify({ overlayOpen: false, bodyBlocked: false, scrollLocked: false, openPortals: 0 }));
}


/** Every visible control that opens a dialog, menu, dropdown or listbox. */
export async function findOverlayTriggers(page: Page) {
  return page
    .locator(
      [
        "[aria-haspopup='dialog']",
        "[aria-haspopup='menu']",
        "[aria-haspopup='listbox']",
        "[aria-haspopup='true']",
        "button[role='combobox']",
        "[data-state='closed'][aria-expanded='false']",
      ].join(", "),
    )
    .filter({ has: page.locator("visible=true") })
    .or(page.locator("[aria-haspopup='dialog']:visible"));
}

/** Open a trigger, wait for the overlay, then dismiss it with Escape. */
export async function cycleTrigger(page: Page, index: number, label: string) {
  const triggers = page.locator(
    "[aria-haspopup='dialog']:visible, [aria-haspopup='menu']:visible, [aria-haspopup='listbox']:visible, button[role='combobox']:visible",
  );
  const trigger = triggers.nth(index);
  if (!(await trigger.count())) return false;

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ timeout: 5_000 }).catch(() => {});

  const overlay = page.locator("[role='dialog']:visible, [role='menu']:visible, [role='listbox']:visible").first();
  const appeared = await overlay
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);

  if (appeared) {
    await expectNoFrozenTiles(page, `${label} (open)`);
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden", timeout: 5_000 }).catch(async () => {
      await page.mouse.click(4, 4);
    });
  }

  await page.waitForTimeout(120);
  await expectNoFrozenTiles(page, `${label} (closed)`);
  return appeared;
}
