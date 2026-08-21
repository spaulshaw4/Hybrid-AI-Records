import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * CI a11y regression gate: axe-core runs on every SyncBadge *state change*.
 *
 * `sync-badge-axe.spec.ts` audits each phase at rest. This suite audits the
 * transitions between them, which is where regressions actually hide: a phase
 * swap can momentarily leave a dangling `aria-describedby`, drop the chip's
 * accessible name while the icon swaps, or paint a low-contrast intermediate
 * colour. Every ordered pair of phases is driven through the harness's live
 * surface and scanned twice — immediately after the change (transient frame)
 * and after it settles.
 *
 * A failure names the exact `from -> to` edge, so CI points straight at the
 * transition that broke.
 */

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const HARNESS = "/dev/sync-badge";
const LIVE = '[data-testid="badge-surface-live"]';

/** Fixed offset so "1m ago" copy never drifts between runs. */
const LAST_RESOLVED_AGO = 61_000;

type LiveState = {
  syncState: "idle" | "loading" | "synced";
  resolveState: unknown;
  conflictNotice: boolean;
  retrying: boolean;
  lastResolvedAt: number | null;
};

/** Mirrors the CASES table in the harness, expressed as drivable patches. */
const STATES: Record<string, (now: number) => LiveState> = {
  idle: () => ({
    syncState: "idle",
    resolveState: null,
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: null,
  }),
  syncing: () => ({
    syncState: "loading",
    resolveState: null,
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: null,
  }),
  synced: () => ({
    syncState: "synced",
    resolveState: null,
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: null,
  }),
  "synced-aligned": (now) => ({
    syncState: "synced",
    resolveState: null,
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: now - LAST_RESOLVED_AGO,
  }),
  resolving: (now) => ({
    syncState: "synced",
    resolveState: {
      phase: "resolving",
      tracks: 2,
      winners: [{ device: "Safari on iOS", count: 2, side: "remote" }],
    },
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: now - LAST_RESOLVED_AGO,
  }),
  resolved: (now) => ({
    syncState: "synced",
    resolveState: {
      phase: "resolved",
      tracks: 3,
      winners: [
        { device: "Safari on iOS", count: 2, side: "remote" },
        { device: "Chrome on macOS", count: 1, side: "local" },
      ],
    },
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: now - LAST_RESOLVED_AGO,
  }),
  conflict: (now) => ({
    syncState: "synced",
    resolveState: null,
    conflictNotice: true,
    retrying: false,
    lastResolvedAt: now - LAST_RESOLVED_AGO,
  }),
  error: () => ({
    syncState: "synced",
    resolveState: {
      phase: "error",
      tracks: 0,
      message: "Couldn't compare playback timestamps from your other devices.",
    },
    conflictNotice: false,
    retrying: false,
    lastResolvedAt: null,
  }),
  "error-retrying": () => ({
    syncState: "synced",
    resolveState: {
      phase: "error",
      tracks: 0,
      message: "Couldn't compare playback timestamps from your other devices.",
    },
    conflictNotice: false,
    retrying: true,
    lastResolvedAt: null,
  }),
};

const PHASES = Object.keys(STATES);

type Violation = { id: string; impact?: string | null; help: string; nodes: string[] };

async function openHarness(page: Page) {
  await page.goto(HARNESS);
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: AXE_PATH });
  // The live surface exposes __hybridBadgeDrive once mounted.
  await page.waitForFunction(
    () => typeof (window as unknown as Record<string, unknown>)["__hybridBadgeDrive"] === "function",
  );
  await page.locator(LIVE).scrollIntoViewIfNeeded();
}

/** Apply a phase to the live badge. */
async function drive(page: Page, phase: string) {
  const state = STATES[phase]!(Date.now());
  await page.evaluate((patch) => {
    (
      (window as unknown as Record<string, unknown>)["__hybridBadgeDrive"] as (p: unknown) => void
    )(patch);
  }, state);
}

async function scan(page: Page, selector: string): Promise<Violation[]> {
  return page.evaluate(async (sel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const results = await axe.run(sel, { resultTypes: ["violations"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nodes: v.nodes.map((n: any) => n.html),
    }));
  }, selector);
}

/**
 * The chip's ARIA contract. Checked on every edge because axe cannot tell that
 * a *missing* description is a regression — only that the markup is legal.
 */
async function chipContract(page: Page) {
  return page.evaluate((sel) => {
    const chip = document.querySelector(`${sel} [data-testid="radio-sync-status"]`);
    if (!chip) return null;
    const ids = (chip.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    return {
      role: chip.getAttribute("role"),
      name: (chip.getAttribute("aria-label") ?? "").trim(),
      live: chip.getAttribute("aria-live"),
      dangling: ids.filter((id) => !(document.getElementById(id)?.textContent ?? "").trim()),
      described: ids.length,
    };
  }, LIVE);
}

/** Assert the badge is healthy right now, labelling any failure with the edge. */
async function assertHealthy(page: Page, edge: string) {
  expect(await scan(page, LIVE), `axe violations ${edge}`).toEqual([]);

  const chip = await chipContract(page);
  expect(chip, `chip missing ${edge}`).not.toBeNull();
  expect([`status`, `alert`], `chip role ${edge}`).toContain(chip!.role);
  expect(chip!.name.length, `chip accessible name ${edge}`).toBeGreaterThan(0);
  expect(chip!.described, `aria-describedby present ${edge}`).toBeGreaterThan(0);
  expect(chip!.dangling, `dangling aria-describedby ${edge}`).toEqual([]);
  // Retry must never use the `disabled` attribute — it would leave the a11y
  // tree mid-transition and strand a keyboard user.
  const retryDisabled = await page.evaluate(
    (sel) =>
      document.querySelector(`${sel} [data-testid="radio-sync-retry"]`)?.hasAttribute("disabled") ??
      false,
    LIVE,
  );
  expect(retryDisabled, `Retry used disabled ${edge}`).toBe(false);
}

test.describe("axe-core on every SyncBadge state change", () => {
  for (const from of PHASES) {
    test(`transitions out of "${from}" stay violation-free`, async ({ page }) => {
      await openHarness(page);

      for (const to of PHASES) {
        if (to === from) continue;
        const edge = `(${from} -> ${to})`;

        // Land on the source phase and confirm it is clean before the edge, so
        // a failure below is attributable to the transition itself.
        await drive(page, from);
        await expect(page.locator(`${LIVE} [data-testid="radio-sync-status"]`)).toBeVisible();
        await assertHealthy(page, `(baseline ${from})`);

        // Transient frame: scan without waiting for animations to settle.
        await drive(page, to);
        await assertHealthy(page, `${edge} transient`);

        // Settled frame.
        await page.evaluate(
          () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120))),
        );
        await assertHealthy(page, `${edge} settled`);
      }
    });
  }

  test("rapid churn through every phase never produces a violation", async ({ page }) => {
    await openHarness(page);

    // Two full laps with no settle time between changes — this is what a flaky
    // network does to the real badge, and it must stay accessible throughout.
    for (let lap = 0; lap < 2; lap++) {
      for (const phase of PHASES) {
        await drive(page, phase);
        await assertHealthy(page, `(churn lap ${lap} -> ${phase})`);
      }
    }
  });

  test("state changes while the tooltip is open stay violation-free", async ({ page }) => {
    await openHarness(page);
    await drive(page, "resolving");

    const chip = page.locator(`${LIVE} [data-testid="radio-sync-status"]`);
    await chip.focus();
    await expect(page.locator("[data-radix-popper-content-wrapper]:visible")).toHaveCount(1);

    // The tooltip's copy is regenerated on each phase change while it is open —
    // the riskiest path for a stale or dangling description.
    for (const to of ["resolved", "conflict", "error", "error-retrying", "synced"]) {
      await drive(page, to);
      await assertHealthy(page, `(tooltip open -> ${to})`);
      const popper = page.locator("[data-radix-popper-content-wrapper]:visible");
      if (await popper.count()) {
        expect(await scan(page, "[data-radix-popper-content-wrapper]"), `tooltip ${to}`).toEqual([]);
        // The visible tooltip must stay decorative; the chip owns the announcement.
        await expect(page.getByTestId("radio-sync-tooltip").first()).toHaveAttribute(
          "aria-hidden",
          "true",
        );
      }
    }
  });

  test("state changes while Retry is focused keep it usable", async ({ page }) => {
    await openHarness(page);
    await drive(page, "error");

    const retry = page.locator(`${LIVE} [data-testid="radio-sync-retry"]`);
    await retry.focus();

    for (const to of ["error-retrying", "error", "error-retrying"]) {
      await drive(page, to);
      await assertHealthy(page, `(retry focused -> ${to})`);
      // Focus must survive the swap, or a keyboard user is dumped to <body>.
      expect(
        await page.evaluate(
          () => document.activeElement?.getAttribute("data-testid") ?? "body",
        ),
        `focus lost on ${to}`,
      ).toBe("radio-sync-retry");
    }
  });
});
