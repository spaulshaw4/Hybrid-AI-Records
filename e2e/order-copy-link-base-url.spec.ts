import { expect, test, type Page } from "@playwright/test";

/**
 * The copied share link must be absolute and rooted at the *current
 * environment's* origin — the same host the page is being served from.
 * A hardcoded/stale origin (localhost leaking into a deployed CI run, or a
 * preview host leaking into local dev) would produce links that break for
 * whoever receives them.
 *
 * Coverage: canonical package slugs, alias slugs (which must be normalized to
 * their canonical form in the shared URL), and the no-package `/#order` case.
 */

const PACKAGE_SELECT = "#qo-package";

// Mirrors playwright.config.ts `use.baseURL` (read at module scope, where
// test.info() isn't available yet).
const BASE = new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080");
/** True when this run targets a real deployment rather than a local dev server. */
const IS_REMOTE_BASE = !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(BASE.hostname);

const LOCAL_HOST_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i;

/** Entry URL -> canonical slug expected in the copied link (null = no package). */
const CANONICAL_SLUGS = ["distribution-release", "visual-push", "full-label"];

/** `slug: undefined` means "any canonical slug, or none". */
const CASES: Array<{ name: string; entry: string; slug?: string | null }> = [
  // No `?package=`: the form falls back to its default tier, so the copied
  // link may carry any canonical slug (or none) — origin/shape still matter.
  { name: "no package", entry: "/#order", slug: undefined },
  { name: "canonical: distribution-release", entry: "/?package=distribution-release#order", slug: "distribution-release" },
  { name: "canonical: visual-push", entry: "/?package=visual-push#order", slug: "visual-push" },
  { name: "canonical: full-label", entry: "/?package=full-label#order", slug: "full-label" },
  { name: "alias: foundation", entry: "/?package=foundation#order", slug: "distribution-release" },
  { name: "alias: the-visual-push", entry: "/?package=the-visual-push#order", slug: "visual-push" },
  { name: "alias: full-hybrid", entry: "/?package=full-hybrid#order", slug: "full-label" },
];

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
}

/**
 * Clicks copy and returns the clipboard string. Retries as a unit: the first
 * click can land before hydration finishes (swallowed, or copied before the
 * URL package prefill applied), so we retry until the expected slug is there.
 */
async function copyLink(page: Page, expectSlug?: string | null): Promise<string> {
  let copied = "";
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    if (expectSlug) expect(copied).toContain(`package=${expectSlug}`);
  }).toPass({ timeout: 40_000 });
  return copied;
}

test.describe("Copy Share Link — environment-correct base URL", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE.origin });
  });

  for (const { name, entry, slug } of CASES) {
    test(`copied URL is absolute on the serving origin — ${name}`, async ({ page }) => {
      await open(page, entry);

      const copied = await copyLink(page, slug ?? null);
      const pageOrigin = new URL(page.url()).origin;

      // Absolute, and rooted at the origin actually serving the page.
      expect(copied).toMatch(/^https?:\/\//);
      const url = new URL(copied);
      expect(url.origin).toBe(pageOrigin);
      expect(url.origin).toBe(BASE.origin);
      expect(url.protocol).toBe(BASE.protocol);

      // Never a bare/relative or protocol-relative link.
      expect(copied.startsWith("/")).toBe(false);
      expect(copied.startsWith("//")).toBe(false);

      // Shape: canonical path, canonical package slug, #order hash preserved.
      expect(url.pathname).toBe("/");
      expect(url.hash).toBe("#order");
      const copiedSlug = url.searchParams.get("package");
      if (slug === undefined) {
        expect(copiedSlug === null || CANONICAL_SLUGS.includes(copiedSlug)).toBe(true);
      } else {
        expect(copiedSlug).toBe(slug);
      }

      // Against a deployed base, no local host may leak into the shared link.
      if (IS_REMOTE_BASE) {
        expect(copied).not.toMatch(LOCAL_HOST_PATTERN);
        expect(url.hostname).toBe(BASE.hostname);
      }

      // The toast echoes the exact same absolute URL.
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: /share link copied/i }),
      ).toContainText(copied);
    });
  }

  test("origin tracks the host the page is served from, not a hardcoded one", async ({ page }) => {
    await open(page, "/?package=foundation#order");

    const copied = await copyLink(page, "distribution-release");
    const runtimeOrigin = await page.evaluate(() => window.location.origin);

    expect(new URL(copied).origin).toBe(runtimeOrigin);
    // Sanity: the assertion above is meaningful only if the app is not
    // emitting some other environment's origin.
    if (!IS_REMOTE_BASE) {
      expect(runtimeOrigin).toMatch(LOCAL_HOST_PATTERN);
    } else {
      expect(runtimeOrigin).not.toMatch(LOCAL_HOST_PATTERN);
    }
  });

  test("prefill details ride along without changing the origin", async ({ page }) => {
    await open(page, "/?package=full-hybrid&artist=Test%20Artist&email=a%40b.com#order");

    const copied = await copyLink(page, "full-label");
    const url = new URL(copied);

    expect(url.origin).toBe(BASE.origin);
    expect(url.searchParams.get("package")).toBe("full-label");
    expect(url.searchParams.get("artist")).toBe("Test Artist");
    expect(url.searchParams.get("email")).toBe("a@b.com");
    expect(url.hash).toBe("#order");
  });
});
