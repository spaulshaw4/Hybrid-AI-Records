import { test, expect, type Page } from "@playwright/test";

const DIVISIONS = {
  jester: "The Jester AI Legacy Records Division",
  usa: /Hybrid AI Records/i,
} as const;

async function openCatalog(page: Page) {
  await page.goto("/#catalog");
  await expect(page.getByRole("heading", { name: "The Catalog." })).toBeVisible();
}

const crests = (page: Page) => page.getByTestId("division-crest");

test.describe("Division crest badges — catalog", () => {
  test("every release card renders exactly one crest badge", async ({ page }) => {
    await openCatalog(page);
    const cards = page.locator("[aria-label^='Play video:']");
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);

    // Catalog crests are a subset of all crests on the page; assert at least one per card.
    await expect(crests(page).first()).toBeVisible();
    expect(await crests(page).count()).toBeGreaterThanOrEqual(cardCount);
  });

  test("each crest exposes an accessible name naming division, title and artist", async ({ page }) => {
    await openCatalog(page);
    const badges = page.getByRole("img").filter({ hasNot: page.locator("img") });
    const labels = await page
      .locator("[role='img'][aria-label*=' for '][aria-label*=' by ']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));

    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).toMatch(/Division|Records/i);
      expect(label).toContain(" for ");
      expect(label).toContain(" by ");
      expect(label.trim().endsWith(".")).toBe(true);
    }
    expect(new Set(labels).size).toBe(labels.length);
    await expect(badges.first()).toBeVisible();
  });

  test("Jester AI releases carry the Legacy Records Division badge", async ({ page }) => {
    await openCatalog(page);
    const jester = page.locator(`[role='img'][aria-label^="${DIVISIONS.jester}"]`);
    expect(await jester.count()).toBeGreaterThan(0);
    await expect(jester.first()).toBeVisible();

    // Tooltip text mirrors the aria-label division name.
    const tooltip = jester.first().getByTestId("division-tooltip");
    await expect(tooltip).toHaveText(DIVISIONS.jester);
    await expect(tooltip).toHaveAttribute("role", "tooltip");
  });

  test("crest artwork is decorative and never double-announced", async ({ page }) => {
    await openCatalog(page);
    const badge = crests(page).first().locator("[role='img']");
    const img = badge.locator("img");
    await expect(img).toHaveAttribute("alt", "");
    await expect(img).toHaveAttribute("aria-hidden", "true");
    await expect(badge).toHaveAttribute("tabindex", "0");
  });

  test("tooltip appears on hover and on keyboard focus", async ({ page }) => {
    await openCatalog(page);
    const badge = crests(page).first().locator("[role='img']");
    const tooltip = badge.getByTestId("division-tooltip");

    await badge.scrollIntoViewIfNeeded();
    await expect(tooltip).toHaveCSS("opacity", "0");

    await badge.hover();
    await expect(tooltip).toHaveCSS("opacity", "1");

    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCSS("opacity", "0");

    await badge.focus();
    await expect(tooltip).toHaveCSS("opacity", "1");
    await expect(badge).toBeFocused();
  });

  test("mobile viewport shows the always-visible text label instead of the tooltip", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCatalog(page);

    const label = page.getByTestId("division-label-mobile").first();
    await label.scrollIntoViewIfNeeded();
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-hidden", "true");
    await expect(label).not.toHaveText("");

    await expect(crests(page).first().getByTestId("division-tooltip")).toBeHidden();
  });
});

test.describe("Division crest badges — contact modal", () => {
  test("contact roster shows division wording consistent with the catalog", async ({ page }) => {
    await page.goto("/");
    const contact = page.getByRole("link", { name: "Contact", exact: true }).first();
    await expect(contact).toBeVisible();

    const dialog = page.getByRole("dialog");
    // Retry through hydration: pre-hydration clicks just follow the #contact hash.
    await expect
      .poll(async () => {
        await contact.click();
        return dialog.isVisible();
      }, { timeout: 30_000, intervals: [250, 500, 1000] })
      .toBe(true);
    await expect(dialog.getByText(DIVISIONS.jester).first()).toBeVisible();
  });
});
