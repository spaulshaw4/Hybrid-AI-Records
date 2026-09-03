import { test, expect, type Page } from "@playwright/test";
import { waitForHarnessHydrated } from "./helpers/sync-badge-aria";

/**
 * Screen-reader-style end-to-end coverage for the sync badge.
 *
 * Instead of asserting on CSS classes or visible chip shorthand ("Synced",
 * "Resolved 3"), every assertion here goes through the accessibility tree the
 * way a screen reader does:
 *
 *  - reaching controls with real Tab presses (no programmatic .focus()),
 *  - locating them by ARIA role + computed accessible name,
 *  - recording what an assistive technology would hear by observing the
 *    aria-live regions for text and attribute changes.
 *
 * The harness at /dev/sync-badge renders every phase on a dark and a light
 * surface, so each phase's announced sentence is verified in isolation.
 */

const HARNESS = "/dev/sync-badge";

/** Relative-time tail drifts while the suite runs, so match it loosely. */
const ALIGNED = String.raw` Devices last aligned \d+[smhd] ago\.`;

type Phase = { id: string; announced: RegExp; chipRole: "status" | "alert" };

const PHASES: Phase[] = [
  { id: "synced", announced: /^Mix synced\.$/, chipRole: "status" },
  { id: "synced-aligned", announced: new RegExp(`^Mix synced\\.${ALIGNED}$`), chipRole: "status" },
  { id: "syncing", announced: /^Syncing your mix\.$/, chipRole: "status" },
  {
    id: "resolving",
    announced: /^Resolving playback timestamps across your devices\.$/,
    chipRole: "status",
  },
  {
    id: "resolved",
    announced: new RegExp(
      `^Resolved\\. Kept the most recent play position for 3 tracks\\.${ALIGNED}$`,
    ),
    chipRole: "status",
  },
  {
    id: "conflict",
    announced: new RegExp(`^A newer mix from another device was restored\\.${ALIGNED}$`),
    chipRole: "status",
  },
  {
    id: "error",
    announced: /^Sync failed\. Couldn't compare playback timestamps from your other devices\.$/,
    chipRole: "alert",
  },
  {
    id: "error-retrying",
    announced: /^Sync failed\. Couldn't compare playback timestamps from your other devices\.$/,
    chipRole: "alert",
  },
];

type Announcement = { politeness: string; text: string };

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await waitForHarnessHydrated(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Mirrors how a screen reader picks up live regions: watch every [aria-live]
 * node for text or ARIA attribute changes and log the sentence it would speak.
 * aria-label wins over text content, matching accessible-name computation.
 */
async function recordAnnouncements(page: Page) {
  await page.evaluate(() => {
    const spoken: Announcement[] = [];
    type Announcement = { politeness: string; text: string };

    // aria-atomic="true" means the whole region is re-spoken on any change, so
    // the sentence is the region's own name plus the names of the controls it
    // contains (that is how the Retry/Retrying label reaches the user).
    const sentence = (el: Element) => {
      const own = el.getAttribute("aria-label") || el.textContent || "";
      const parts = [own];
      for (const child of Array.from(el.querySelectorAll("[aria-label]"))) {
        parts.push(child.getAttribute("aria-label") ?? "");
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };

    const speak = (el: Element) => {
      const text = sentence(el);
      const politeness = el.getAttribute("aria-live") ?? "off";
      const last = spoken[spoken.length - 1];
      if (!text || (last && last.text === text && last.politeness === politeness)) return;
      spoken.push({ politeness, text });
    };

    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const target = r.target instanceof Element ? r.target : r.target.parentElement;
        const region = target?.closest("[aria-live]");
        if (region) speak(region);
        if (r.type === "childList") {
          for (const node of Array.from(r.addedNodes)) {
            if (node instanceof Element) {
              for (const added of node.matches("[aria-live]") ? [node] : Array.from(node.querySelectorAll("[aria-live]")))
                speak(added);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-live", "aria-disabled", "disabled"],
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__srSpoken = spoken;
  });
}

async function spoken(page: Page): Promise<Announcement[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => ((window as any).__srSpoken ?? []) as Announcement[]);
}

/** Describes the focused node the way an AT would: role, name, disabled. */
async function focusedNode(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? (el.tagName === "BUTTON" ? "button" : ""),
      name: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim(),
      testid: el.getAttribute("data-testid") ?? "",
      disabled: el.getAttribute("aria-disabled") === "true",
      owner: el.closest("[data-testid^='badge-']")?.getAttribute("data-testid") ?? "",
    };
  });
}

/**
 * Presses Tab (real key events) until focus lands inside the given badge case,
 * proving the control is reachable by keyboard alone rather than by scripting
 * focus onto it.
 */
async function tabInto(page: Page, owner: string, testid: string, max = 60) {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const node = await focusedNode(page);
    if (node && node.owner === owner && node.testid === testid) return { node, presses: i + 1 };
  }
  throw new Error(`Tab traversal never reached ${testid} inside ${owner}`);
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`screen-reader traversal — ${theme} surface`, () => {
    for (const phase of PHASES) {
      test(`${phase.id}: Tab reaches the badge and it announces its phase`, async ({ page }) => {
        await openHarness(page);
        const owner = `badge-${theme}-${phase.id}`;

        const { node } = await tabInto(page, owner, "radio-sync-status");
        expect(node.role).toBe(phase.chipRole);
        expect(node.name).toMatch(phase.announced);

        // Same assertion through Playwright's accessible-name engine, i.e. the
        // name a screen reader computes rather than the raw attribute.
        const chip = page
          .locator(`[data-testid="${owner}"]`)
          .getByRole(phase.chipRole, { name: phase.announced });
        await expect(chip).toBeVisible();
        await expect(chip).toBeFocused();
        await expect(chip).toHaveAttribute(
          "aria-live",
          phase.chipRole === "alert" ? "assertive" : "polite",
        );
        await expect(chip).toHaveAttribute("aria-atomic", "true");
      });
    }

    test("Tab moves from the failed badge to Retry with the right accessible name", async ({ page }) => {
      await openHarness(page);
      const owner = `badge-${theme}-error`;

      await tabInto(page, owner, "radio-sync-status");
      await page.keyboard.press("Tab");

      const next = await focusedNode(page);
      expect(next).toMatchObject({ tag: "button", owner, testid: "radio-sync-retry" });
      expect(next?.name).toBe("Retry timestamp sync");

      await expect(
        page.locator(`[data-testid="${owner}"]`).getByRole("button", { name: "Retry timestamp sync" }),
      ).toBeFocused();
    });

    test("activating Retry with Enter announces the retrying state", async ({ page }) => {
      await openHarness(page);
      await recordAnnouncements(page);
      const owner = `badge-${theme}-error`;
      const scope = page.locator(`[data-testid="${owner}"]`);

      await tabInto(page, owner, "radio-sync-retry");
      await page.keyboard.press("Enter");

      await expect(page.getByTestId(`retry-count-${theme}-error`)).toHaveText("Retry fired 1");
      await expect(scope.getByRole("button", { name: "Retrying timestamp sync" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      // The old name must be gone — a stale "Retry timestamp sync" would let an
      // AT user press a control that no longer does anything.
      await expect(scope.getByRole("button", { name: "Retry timestamp sync", exact: true })).toHaveCount(0);

      const heard = await spoken(page);
      expect(heard.some((a) => a.politeness === "assertive" && /Retrying timestamp sync/.test(a.text))).toBe(
        true,
      );
    });

    test("activating Retry with Space announces the retrying state", async ({ page }) => {
      await openHarness(page);
      await recordAnnouncements(page);
      const owner = `badge-${theme}-error`;
      const scope = page.locator(`[data-testid="${owner}"]`);

      await tabInto(page, owner, "radio-sync-retry");
      await page.keyboard.press("Space");

      await expect(page.getByTestId(`retry-count-${theme}-error`)).toHaveText("Retry fired 1");
      await expect(scope.getByRole("button", { name: "Retrying timestamp sync" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );

      const heard = await spoken(page);
      expect(heard.some((a) => /Retrying timestamp sync/.test(a.text))).toBe(true);
    });

    test("the failure alert is assertive while the settled phases stay polite", async ({ page }) => {
      await openHarness(page);
      const surface = page.locator(`[data-testid="badge-surface-${theme}"]`);

      await expect(
        surface.locator(`[data-testid="badge-${theme}-error"] [role="alert"][aria-live="assertive"]`),
      ).toHaveCount(1);
      for (const id of ["synced", "resolved", "conflict"]) {
        await expect(
          surface.locator(`[data-testid="badge-${theme}-${id}"] [role="status"][aria-live="polite"]`),
        ).toHaveCount(1);
      }
    });
  });
}
