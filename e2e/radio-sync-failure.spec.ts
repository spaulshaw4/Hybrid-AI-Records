import { test, expect, type Page } from "@playwright/test";

/**
 * Sync failure on one device, end to end.
 *
 * Uses the dev-only `__hybridRadioFailResolve` hook to make this device's
 * timestamp resolution fail exactly the way a network/bad-payload error does,
 * then checks the Sync History panel surfaces the failure and that Retry
 * clears it (and that a subsequent failure is recorded again).
 */

const FAILURES = "hybrid-radio-sync-failures";

async function openRadio(page: Page, { clear = true }: { clear?: boolean } = {}) {
  await page.goto("/");
  // Clear per-test state after navigating (an init script would also run inside
  // same-origin iframes the player creates, wiping storage mid-test).
  if (clear) await page.evaluate((key) => window.localStorage.removeItem(key), FAILURES);
  const title = page.getByTestId("radio-track-title");
  await expect(title).toBeVisible();
  await expect(title).not.toHaveText("—");
  await page.waitForFunction(() => "__hybridRadioFailResolve" in window, undefined, { timeout: 30_000 });
}

async function failResolve(page: Page, message?: string) {
  await page.evaluate((msg) => {
    (window as unknown as Record<string, (m?: string) => void>)["__hybridRadioFailResolve"]!(msg);
  }, message);
}

async function openHistoryPanel(page: Page) {
  const chip = page.getByRole("button", { name: /sync history/i }).first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(page.getByText("Resolved Timestamps")).toBeVisible();
}

test("a failed resolution shows in the Sync History panel", async ({ page }) => {
  await openRadio(page);
  await failResolve(page, "Couldn't reach your account to resolve playback timestamps.");
  await openHistoryPanel(page);

  const panel = page.getByTestId("radio-sync-failures");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Sync Failed");
  await expect(panel).toContainText("Couldn't reach your account");
});

test("the failure is persisted so it survives a reload", async ({ page }) => {
  await openRadio(page);
  await failResolve(page, "Couldn't compare playback timestamps from your other devices.");
  await expect
    .poll(async () => (await page.evaluate((k) => window.localStorage.getItem(k), FAILURES))?.length ?? 0)
    .toBeGreaterThan(2);

  await openRadio(page, { clear: false });
  await openHistoryPanel(page);
  await expect(page.getByTestId("radio-sync-failures")).toContainText("Couldn't compare playback timestamps");
});

test("Retry clears the failure from the panel and from storage", async ({ page }) => {
  await openRadio(page);
  await failResolve(page);
  await openHistoryPanel(page);

  const panel = page.getByTestId("radio-sync-failures");
  await expect(panel).toBeVisible();
  await page.getByTestId("radio-history-retry").click();

  await expect(page.getByTestId("radio-sync-failures")).toHaveCount(0);
  await expect
    .poll(async () => JSON.parse((await page.evaluate((k) => window.localStorage.getItem(k), FAILURES)) ?? "[]").length)
    .toBe(0);
  // The rest of the panel is still usable after recovery.
  await expect(page.getByText("Resolved Timestamps")).toBeVisible();
});

test("a failure after a retry is recorded again", async ({ page }) => {
  await openRadio(page);
  await failResolve(page, "First failure");
  await openHistoryPanel(page);
  await page.getByTestId("radio-history-retry").click();
  await expect(page.getByTestId("radio-sync-failures")).toHaveCount(0);

  await failResolve(page, "Second failure");
  const panel = page.getByTestId("radio-sync-failures");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Second failure");
  await expect(panel).not.toContainText("First failure");
});

test("repeated failures are listed newest first", async ({ page }) => {
  await openRadio(page);
  await failResolve(page, "Older failure");
  await failResolve(page, "Newer failure");
  await openHistoryPanel(page);

  const rows = page.getByTestId("radio-sync-failures").locator("li");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Newer failure");
  await expect(rows.nth(1)).toContainText("Older failure");

  // One Retry clears every recorded failure.
  await page.getByTestId("radio-history-retry").click();
  await expect(page.getByTestId("radio-sync-failures")).toHaveCount(0);
});
