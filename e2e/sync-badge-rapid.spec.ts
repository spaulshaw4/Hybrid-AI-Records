import { test, expect, type Page } from "@playwright/test";

/**
 * Rapid phase-churn coverage for the sync badge.
 *
 * Static per-phase specs prove each state announces correctly on its own. This
 * suite drives one live badge through fast failure → retry → failure → retry →
 * recovery cycles (the shape of a flaky network) and asserts the two things
 * that actually break under churn:
 *
 *  1. the screen reader hears every phase, in order, with the right politeness
 *     (assertive for failures, polite for progress/success), and
 *  2. keyboard focus never falls to <body> — Retry keeps focus while it exists,
 *     and focus lands on the status chip once Retry is gone.
 */

const HARNESS = "/dev/sync-badge";
const OWNER = "badge-live";

const FAIL_MESSAGE = "Couldn't compare playback timestamps from your other devices.";

type LivePatch = {
  syncState?: "idle" | "loading" | "synced";
  resolveState?:
    | {
        phase: "resolving" | "resolved" | "error";
        tracks: number;
        message?: string;
        winners?: { device: string; count: number; side: "local" | "remote" }[];
      }
    | null;
  conflictNotice?: boolean;
  retrying?: boolean;
  lastResolvedAt?: number | null;
};

const ERROR_PATCH: LivePatch = {
  syncState: "synced",
  resolveState: { phase: "error", tracks: 0, message: FAIL_MESSAGE },
  retrying: false,
  lastResolvedAt: null,
};

type Announcement = { politeness: string; text: string };

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await expect(page.getByTestId(OWNER)).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Same live-region observer strategy the screen-reader spec uses. */
async function recordAnnouncements(page: Page) {
  await page.evaluate(() => {
    type Announcement = { politeness: string; text: string };
    const spoken: Announcement[] = [];

    const sentence = (el: Element) => {
      const own = el.getAttribute("aria-label") || el.textContent || "";
      const parts = [own];
      for (const child of Array.from(el.querySelectorAll("[aria-label]"))) {
        parts.push(child.getAttribute("aria-label") ?? "");
      }
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };

    const speak = (el: Element) => {
      if (!el.closest("[data-testid='badge-live']")) return;
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
            if (!(node instanceof Element)) continue;
            const regions = node.matches("[aria-live]")
              ? [node]
              : Array.from(node.querySelectorAll("[aria-live]"));
            for (const added of regions) speak(added);
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

    // Seed with whatever is on screen when recording starts.
    for (const region of Array.from(document.querySelectorAll("[data-testid='badge-live'] [aria-live]")))
      speak(region);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__srSpoken = spoken;
  });
}

async function spoken(page: Page): Promise<Announcement[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => ((window as any).__srSpoken ?? []) as Announcement[]);
}

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

/** Real Tab presses until focus lands on the wanted control inside the live badge. */
async function tabInto(page: Page, testid: string, max = 80) {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const node = await focusedNode(page);
    if (node && node.owner === OWNER && node.testid === testid) return node;
  }
  throw new Error(`Tab traversal never reached ${testid} inside ${OWNER}`);
}

async function drive(page: Page, patch: LivePatch) {
  await page.evaluate((p) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__hybridBadgeDrive(p);
  }, patch);
}

/** Focus sampled between every transition, so a single dropped frame is caught. */
async function driveAndSample(page: Page, steps: LivePatch[], dwellMs = 40) {
  const samples: Awaited<ReturnType<typeof focusedNode>>[] = [];
  for (const step of steps) {
    await drive(page, step);
    await page.waitForTimeout(dwellMs);
    samples.push(await focusedNode(page));
  }
  return samples;
}

test.describe("sync badge — rapid phase transitions", () => {
  test("keyboard focus stays on Retry across repeated failure/retry churn", async ({ page }) => {
    await openHarness(page);
    const focused = await tabInto(page, "radio-sync-retry");
    expect(focused.name).toBe("Retry timestamp sync");

    // Five failure→retrying→failure cycles at ~40ms dwell: faster than a user
    // could react, which is exactly when focus normally gets dropped.
    const steps: LivePatch[] = [];
    for (let i = 0; i < 5; i++) {
      steps.push({ retrying: true });
      steps.push({ ...ERROR_PATCH, retrying: false });
    }
    const samples = await driveAndSample(page, steps);

    for (const [i, sample] of samples.entries()) {
      expect(sample, `focus lost at transition ${i}`).not.toBeNull();
      expect(sample!.testid, `wrong element focused at transition ${i}`).toBe("radio-sync-retry");
      expect(sample!.owner).toBe(OWNER);
    }
    // Retrying disables the button; the disabled control must keep focus rather
    // than dumping the user back to the top of the page.
    expect(samples.filter((s) => s!.disabled).length).toBe(5);
    expect(await focusedNode(page)).toMatchObject({
      testid: "radio-sync-retry",
      name: "Retry timestamp sync",
      disabled: false,
    });
  });

  test("every phase in a failure → recovery burst is announced in order", async ({ page }) => {
    await openHarness(page);
    await recordAnnouncements(page);

    await driveAndSample(page, [
      { retrying: true },
      { ...ERROR_PATCH, retrying: false },
      { retrying: true },
      { ...ERROR_PATCH, retrying: false },
      { retrying: true },
      { retrying: false, resolveState: { phase: "resolving", tracks: 2 } },
      {
        resolveState: {
          phase: "resolved",
          tracks: 2,
          winners: [{ device: "Safari on iOS", count: 2, side: "remote" }],
        },
        lastResolvedAt: Date.now(),
      },
    ]);

    const heard = await spoken(page);
    const texts = heard.map((h) => h.text);

    // Failures speak assertively; progress and success stay polite so they do
    // not interrupt whatever the listener is doing.
    for (const h of heard) {
      if (h.text.startsWith("Sync failed")) expect(h.politeness).toBe("assertive");
      else expect(h.politeness).toBe("polite");
    }

    const failures = texts.filter((t) => t.startsWith("Sync failed"));
    expect(failures.length).toBeGreaterThanOrEqual(3);
    expect(failures.every((t) => t.includes(FAIL_MESSAGE))).toBe(true);
    // The retrying label must reach the live region, not just the pixels.
    expect(texts.some((t) => t.includes("Retrying timestamp sync"))).toBe(true);

    const resolvingAt = texts.findIndex((t) => t.startsWith("Resolving playback timestamps"));
    const resolvedAt = texts.findIndex((t) => t.startsWith("Resolved."));
    expect(resolvingAt).toBeGreaterThan(-1);
    expect(resolvedAt).toBeGreaterThan(resolvingAt);
    expect(texts[texts.length - 1]).toMatch(/^Resolved\. Kept the most recent play position for 2 tracks\./);
    // Nothing stale re-announced after recovery.
    expect(texts.slice(resolvedAt).some((t) => t.startsWith("Sync failed"))).toBe(false);
  });

  test("focus survives recovery and returns to a focusable status chip", async ({ page }) => {
    await openHarness(page);
    await tabInto(page, "radio-sync-retry");

    // Retry disappears when the phase recovers; focus must land on the chip that
    // replaces it instead of resetting to <body>.
    await drive(page, { retrying: true });
    await page.waitForTimeout(40);
    await drive(page, { retrying: false, resolveState: { phase: "resolving", tracks: 1 } });
    await page.waitForTimeout(60);

    const chip = page.getByTestId(OWNER).getByTestId("radio-sync-status");
    await expect(chip).toBeVisible();
    await expect(page.getByTestId(OWNER).getByTestId("radio-sync-retry")).toHaveCount(0);

    // The chip is keyboard reachable in the recovered phase.
    const node = await tabInto(page, "radio-sync-status");
    expect(node.role).toBe("status");
    expect(node.name).toBe("Resolving playback timestamps across your devices.");
  });

  test("a late failure after recovery re-announces assertively and re-focuses Retry", async ({ page }) => {
    await openHarness(page);
    await recordAnnouncements(page);
    await tabInto(page, "radio-sync-retry");

    await drive(page, { retrying: true });
    await page.waitForTimeout(40);
    await drive(page, { retrying: false, resolveState: { phase: "resolved", tracks: 1 }, lastResolvedAt: Date.now() });
    await page.waitForTimeout(60);
    // Network drops again straight after a success.
    await drive(page, ERROR_PATCH);
    await page.waitForTimeout(80);

    const retry = page.getByTestId(OWNER).getByTestId("radio-sync-retry");
    await expect(retry).toBeVisible();
    // Focus was on Retry before it unmounted, so the badge restores it.
    await expect(retry).toBeFocused();

    const texts = (await spoken(page)).map((t) => t.text);
    expect(texts[texts.length - 1]).toMatch(/^Sync failed\./);
    const heard = await spoken(page);
    expect(heard[heard.length - 1]!.politeness).toBe("assertive");
  });

  test("Retry stays activatable by keyboard after the churn", async ({ page }) => {
    await openHarness(page);
    await tabInto(page, "radio-sync-retry");

    await driveAndSample(page, [
      { retrying: true },
      { ...ERROR_PATCH, retrying: false },
      { retrying: true },
      { ...ERROR_PATCH, retrying: false },
    ]);

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("live-retry-count")).toHaveText("Retry fired 1");
    await page.keyboard.press("Space");
    await expect(page.getByTestId("live-retry-count")).toHaveText("Retry fired 2");
    await expect(page.getByTestId(OWNER).getByTestId("radio-sync-retry")).toBeFocused();
  });
});
