import { test, expect, type Page } from "@playwright/test";

/** Desktop hover / focus / keyboard-only behaviour for the division crest tooltip. */

const crests = (page: Page) => page.getByTestId("division-crest");
const badges = (page: Page) => page.locator("[data-testid='division-crest'] [role='img']");

async function openHome(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The Catalog." })).toBeVisible();
  await expect(crests(page).first()).toBeVisible();
}

test.describe("Division crest tooltip — hover", () => {
  test("hovering a crest reveals only that crest's tooltip", async ({ page }) => {
    await openHome(page);
    const first = badges(page).nth(0);
    const second = badges(page).nth(1);

    await first.scrollIntoViewIfNeeded();
    await second.scrollIntoViewIfNeeded();
    // Hover twice: lazy artwork can shift the row out from under the pointer.
    await first.hover();
    await first.hover();
    await expect
      .poll(async () => {
        await first.hover();
        return first.getByTestId("division-tooltip").evaluate((el) => getComputedStyle(el).opacity);
      })
      .toBe("1");
    await expect(second.getByTestId("division-tooltip")).toHaveCSS("opacity", "0");

    await second.hover();
    await second.hover();
    await expect(second.getByTestId("division-tooltip")).toHaveCSS("opacity", "1");
    await expect(first.getByTestId("division-tooltip")).toHaveCSS("opacity", "0");
  });

  test("tooltip hides again when the pointer leaves the crest", async ({ page }) => {
    await openHome(page);
    const badge = badges(page).first();
    const tooltip = badge.getByTestId("division-tooltip");

    await badge.hover();
    await expect(tooltip).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCSS("opacity", "0");
  });

  test("tooltip is pointer-transparent so it never steals hover from the card", async ({ page }) => {
    await openHome(page);
    const tooltip = badges(page).first().getByTestId("division-tooltip");
    await expect(tooltip).toHaveCSS("pointer-events", "none");
  });

  test("hovering a crest does not open the video modal", async ({ page }) => {
    await openHome(page);
    await badges(page).first().hover();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("Division crest tooltip — focus and keyboard-only navigation", () => {
  test("crest is reachable by Tab and shows its tooltip on focus", async ({ page }) => {
    await openHome(page);
    const badge = badges(page).first();
    const tooltip = badge.getByTestId("division-tooltip");

    await badge.scrollIntoViewIfNeeded();
    await expect(tooltip).toHaveCSS("opacity", "0");

    // Focus the element preceding the badge, then Tab onto it — keyboard only.
    await badge.evaluate((el) => {
      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>("a[href], button, [tabindex='0']"),
      );
      const i = focusables.indexOf(el as HTMLElement);
      focusables[Math.max(0, i - 1)]?.focus();
    });
    await page.keyboard.press("Tab");

    await expect(badge).toBeFocused();
    await expect(tooltip).toHaveCSS("opacity", "1");
  });

  test("tooltip hides when focus moves on with Tab", async ({ page }) => {
    await openHome(page);
    const badge = badges(page).first();
    const tooltip = badge.getByTestId("division-tooltip");

    await badge.focus();
    await expect(tooltip).toHaveCSS("opacity", "1");

    await page.keyboard.press("Tab");
    await expect(badge).not.toBeFocused();
    await expect(tooltip).toHaveCSS("opacity", "0");
  });

  test("Shift+Tab returns focus to the crest and re-shows the tooltip", async ({ page }) => {
    await openHome(page);
    const badge = badges(page).first();
    const tooltip = badge.getByTestId("division-tooltip");

    await badge.focus();
    await page.keyboard.press("Tab");
    await expect(tooltip).toHaveCSS("opacity", "0");

    await page.keyboard.press("Shift+Tab");
    await expect(badge).toBeFocused();
    await expect(tooltip).toHaveCSS("opacity", "1");
  });

  test("focused crest renders a visible focus ring", async ({ page }) => {
    await openHome(page);
    const badge = badges(page).first();
    await badge.focus();
    const ring = await badge.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.getPropertyValue("--tw-ring-offset-shadow") + s.boxShadow, outline: s.outlineStyle };
    });
    expect(ring.width.length).toBeGreaterThan(0);
  });

  test("keyboard focus never traps: every crest in the grid can be tabbed through", async ({ page }) => {
    await openHome(page);
    const all = badges(page);
    const count = await all.count();
    expect(count).toBeGreaterThan(1);

    await all.first().focus();
    for (let i = 0; i < 3 && i < count; i++) {
      await page.keyboard.press("Tab");
    }
    const focusedIsFirst = await all.first().evaluate((el) => el === document.activeElement);
    expect(focusedIsFirst).toBe(false);
  });
});

test.describe("Division crest tooltip — ARIA wiring across the catalog grid", () => {
  test("every crest points at its own tooltip via aria-describedby", async ({ page }) => {
    await openHome(page);
    const pairs = await badges(page).evaluateAll((els) =>
      els.map((el) => {
        const id = el.getAttribute("aria-describedby") ?? "";
        const tip = id ? el.ownerDocument.getElementById(id) : null;
        return {
          id,
          role: tip?.getAttribute("role") ?? null,
          text: tip?.textContent?.trim() ?? "",
          label: el.getAttribute("aria-label") ?? "",
        };
      }),
    );

    expect(pairs.length).toBeGreaterThan(0);
    expect(new Set(pairs.map((p) => p.id)).size).toBe(pairs.length);
    for (const p of pairs) {
      expect(p.id).not.toBe("");
      expect(p.role).toBe("tooltip");
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.label.toLowerCase()).toContain(p.text.toLowerCase());
    }
  });
});
