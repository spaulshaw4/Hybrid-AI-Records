import { test, expect, type Page } from "@playwright/test";

/**
 * Regression guard for the LivingBackground layer.
 *
 * Two invariants are checked on every listed route:
 *  1. the `.living-bg` layer exists, paints, and sits in a negative stacking
 *     context so route content always renders in front of it;
 *  2. no route shell (or overlay: modal, dropdown, toast) covers it with an
 *     opaque surface — the background must still read through the glass.
 *
 * Overlays additionally must win the hit test at their own center, proving the
 * background can never float above interactive chrome.
 */

const ROUTES = [
  "/",
  "/start",
  "/catalog",
  "/podcast",
  "/veteran-certification",
  "/order-status",
  "/track-status",
];

type Probe = {
  present: boolean;
  zIndex: number;
  hidden: boolean;
  worstAlpha: number;
  blockedPoints: number;
  totalPoints: number;
  culprits: string[];
  hitsBackground: boolean;
};

/** Samples a grid of points and reports the strongest surface painted above the layer. */
async function probeBackground(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const bg = document.querySelector<HTMLElement>(".living-bg");
    if (!bg) {
      return {
        present: false,
        zIndex: 0,
        hidden: true,
        worstAlpha: 1,
        blockedPoints: 0,
        totalPoints: 0,
        culprits: [],
        hitsBackground: false,
      };
    }

    const style = getComputedStyle(bg);
    const hidden =
      style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;

    const alphaOf = (color: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(color);
      if (!m) return 0;
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };

    const w = window.innerWidth;
    const h = window.innerHeight;
    const points: Array<[number, number]> = [];
    for (const fx of [0.12, 0.5, 0.88]) {
      for (const fy of [0.15, 0.45, 0.8]) points.push([w * fx, h * fy]);
    }

    let worstAlpha = 0;
    let blockedPoints = 0;
    let hitsBackground = false;
    const culprits = new Set<string>();

    for (const [x, y] of points) {
      let el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (el?.closest("[data-site-nav]")) continue;
      // The layer is pointer-events:none, so it must never win a hit test.
      if (el && (el.classList.contains("living-bg") || el.closest(".living-bg"))) {
        hitsBackground = true;
      }
      let alpha = 0;
      let source = "";
      // Stop at <body>: its background propagates to the canvas and paints
      // behind a negative z-index layer, so it can never block it.
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.classList.contains("living-bg") || el.closest(".living-bg")) break;
        if (el.closest("[data-site-nav]")) break;
        const s = getComputedStyle(el);
        const a = alphaOf(s.backgroundColor);
        if (a > alpha) {
          alpha = a;
          source =
            el.tagName.toLowerCase() +
            (el.className ? `.${String(el.className).split(/\s+/)[0]}` : "");
        }
        el = el.parentElement;
      }
      if (alpha >= 0.9) blockedPoints += 1;
      if (alpha > worstAlpha) worstAlpha = alpha;
      if (alpha >= 0.5 && source) culprits.add(source);
    }

    return {
      present: true,
      zIndex: Number(style.zIndex) || 0,
      hidden,
      worstAlpha,
      blockedPoints,
      totalPoints: points.length,
      culprits: [...culprits],
      hitsBackground,
    };
  });
}

/** Confirms an open overlay stacks above the background and owns its own hit test. */
async function expectOverlayAboveBackground(page: Page, selector: string, label: string) {
  const result = await page.evaluate((sel) => {
    const overlay = document.querySelector<HTMLElement>(sel);
    const bg = document.querySelector<HTMLElement>(".living-bg");
    if (!overlay || !bg) return { found: false, ownsHit: false, bgZ: 0, stackedAbove: false };

    const bgZ = Number(getComputedStyle(bg).zIndex) || 0;

    // Walk up from the overlay to find its effective stacking z-index.
    let node: HTMLElement | null = overlay;
    let overlayZ = 0;
    while (node && node !== document.body) {
      const z = Number(getComputedStyle(node).zIndex);
      if (!Number.isNaN(z) && z !== 0) {
        overlayZ = z;
        break;
      }
      node = node.parentElement;
    }

    const box = overlay.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.min(Math.max(box.left + box.width / 2, 1), window.innerWidth - 1),
      Math.min(Math.max(box.top + box.height / 2, 1), window.innerHeight - 1),
    ) as HTMLElement | null;

    return {
      found: true,
      ownsHit: !!hit && (overlay.contains(hit) || hit.contains(overlay)),
      bgZ,
      overlayZ,
      stackedAbove: overlayZ > bgZ,
    };
  }, selector);

  expect(result.found, `${label} should be open`).toBe(true);
  expect(result.stackedAbove, `${label} must stack above .living-bg`).toBe(true);
  expect(result.ownsHit, `${label} must receive pointer hits, not the background`).toBe(true);
}

test.describe("LivingBackground stacking", () => {
  for (const path of ROUTES) {
    test(`sits behind content on ${path}`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700); // allow crest decode + skeleton swap

      const probe = await probeBackground(page);
      expect(probe.present, `.living-bg missing on ${path}`).toBe(true);
      expect(probe.hidden, `.living-bg hidden by CSS on ${path}`).toBe(false);
      expect(probe.zIndex, `.living-bg must use a negative z-index on ${path}`).toBeLessThan(0);
      expect(probe.hitsBackground, `.living-bg must not capture pointer hits on ${path}`).toBe(
        false,
      );
      expect(
        probe.blockedPoints,
        `opaque surface covers .living-bg on ${path}: ${probe.culprits.join(", ")}`,
      ).toBe(0);
      expect(
        probe.worstAlpha,
        `page shell on ${path} is too opaque (${probe.worstAlpha}) — ${probe.culprits.join(", ")}`,
      ).toBeLessThan(0.9);

      const bg = page.locator(".living-bg").first();
      await expect(bg).toHaveAttribute("data-tier", /^(full|lite|static)$/);
      await expect(bg).toHaveAttribute("data-paused", "false");
      if (test.info().project.name.includes("mobile")) {
        const tier = await bg.getAttribute("data-tier");
        expect(["lite", "static"]).toContain(tier);
      }
    });
  }

  /**
   * Clicks a trigger until the overlay appears. Under parallel workers the
   * page can still be hydrating, so the first click may land before the
   * handler is attached.
   */
  async function openOverlay(page: Page, trigger: () => Promise<void>, overlaySel: string) {
    const overlay = page.locator(overlaySel).first();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await trigger();
      try {
        await overlay.waitFor({ state: "visible", timeout: 2_000 });
        return overlay;
      } catch {
        await page.waitForTimeout(500);
      }
    }
    await expect(overlay, "overlay never opened").toBeVisible();
    return overlay;
  }

  test("stays behind the settings dropdown", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const sel = "[role='dialog'],[role='menu']";
    await openOverlay(
      page,
      () => page.getByRole("button", { name: "Site settings" }).first().click({ force: true }),
      sel,
    );
    await expectOverlayAboveBackground(page, sel, "Settings panel");
  });

  test("stays behind the About modal", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await openOverlay(
      page,
      () => page.getByRole("link", { name: "About" }).first().click({ force: true }),
      "[role='dialog']",
    );
    await expectOverlayAboveBackground(page, "[role='dialog']", "About modal");

    // Background must still be present (never unmounted) while a modal is open.
    const probe = await probeBackground(page);
    expect(probe.present).toBe(true);
    expect(probe.zIndex).toBeLessThan(0);
  });

  test("pauses the crest rotation when the tab is hidden", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const bg = page.locator(".living-bg").first();
    await expect(bg).toHaveAttribute("data-paused", "false");

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(bg).toHaveAttribute("data-paused", "true");
  });
});

