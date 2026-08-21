import { test, expect, type Page } from "@playwright/test";

/**
 * Sync History persistence across reloads.
 *
 * Everything the panel shows is backed by localStorage, so a reload must
 * restore the same rows — in particular the latest resolved timestamp per
 * track, which must survive both a reload and a long tail of newer playback
 * events that would otherwise push it past the history limit.
 */

const POSITIONS = "hybrid-radio-positions";
const TIMES = "hybrid-radio-position-times";
const DEVICES = "hybrid-radio-position-devices";
const HISTORY = "hybrid-radio-sync-history";

async function openRadio(page: Page) {
  await page.goto("/");
  const title = page.getByTestId("radio-track-title");
  await expect(title).toBeVisible();
  await expect(title).not.toHaveText("—");
  await page.waitForFunction(() => "__hybridRadioAdoptRemote" in window && "__hybridRadioTrackKeys" in window, undefined, {
    timeout: 30_000,
  });
}

async function trackKeys(page: Page) {
  const keys = await page.evaluate(
    () => (window as unknown as Record<string, string[]>)["__hybridRadioTrackKeys"] ?? [],
  );
  expect(keys.length).toBeGreaterThan(2);
  return keys;
}

async function recordSeek(page: Page, key: string, seconds: number, at: number, device: string) {
  await page.evaluate(
    ({ key, seconds, at, device, POSITIONS, TIMES, DEVICES }) => {
      const merge = (name: string, value: unknown) => {
        const raw = window.localStorage.getItem(name);
        const map = raw ? JSON.parse(raw) : {};
        map[key] = value;
        window.localStorage.setItem(name, JSON.stringify(map));
      };
      merge(POSITIONS, seconds);
      merge(TIMES, at);
      merge(DEVICES, device);
    },
    { key, seconds, at, device, POSITIONS, TIMES, DEVICES },
  );
}

async function receiveFromAccount(
  page: Page,
  key: string,
  seconds: number,
  at: number,
  device: string,
) {
  await page.evaluate(
    ({ key, seconds, at, device }) => {
      const adopt = (window as unknown as Record<string, (r: unknown) => void>)["__hybridRadioAdoptRemote"];
      adopt({
        mixStyle: "artist",
        shuffle: false,
        spacing: 1,
        mixSeed: 0,
        trackKey: key,
        queue: [],
        positions: { [key]: seconds },
        positionTimes: { [key]: at },
        positionDevices: { [key]: device },
        updatedAt: new Date().toISOString(),
      });
    },
    { key, seconds, at, device },
  );
}

async function openSyncHistory(page: Page) {
  await page.getByRole("button", { name: /Sync History/i }).click();
}

const resolutions = (page: Page) => page.getByTestId("radio-resolutions").locator("li");

test.describe("Hybrid AI Radio — Sync History persistence", () => {
  test("resolved timestamps are restored after a reload", async ({ page }) => {
    await openRadio(page);
    const [, keyA, keyB] = await trackKeys(page);
    const now = Date.now();

    await recordSeek(page, keyA!, 20, now - 90_000, "Chrome on macOS");
    await recordSeek(page, keyB!, 45, now - 90_000, "Chrome on macOS");
    await openSyncHistory(page);

    await receiveFromAccount(page, keyA!, 120, now - 2_000, "Safari on iOS");
    await receiveFromAccount(page, keyB!, 305, now - 1_000, "Pixel on Android");
    await expect(resolutions(page)).toHaveCount(2);

    await page.reload();
    await openRadio(page);
    await openSyncHistory(page);

    const rows = resolutions(page);
    await expect(rows).toHaveCount(2);
    const text = (await rows.allInnerTexts()).join("\n").toLowerCase();
    expect(text).toContain("2:00");
    expect(text).toContain("safari on ios");
    expect(text).toContain("5:05");
    expect(text).toContain("pixel on android");

  });

  test("resolved rows survive a flood of newer playback events", async ({ page }) => {
    await openRadio(page);
    const [, keyA] = await trackKeys(page);
    const now = Date.now();

    await recordSeek(page, keyA!, 10, now - 300_000, "Chrome on macOS");
    await openSyncHistory(page);
    await receiveFromAccount(page, keyA!, 200, now - 250_000, "Safari on iOS");
    await expect(resolutions(page)).toHaveCount(1);

    // 400 newer events — more than the history limit — must not evict it.
    await page.evaluate(
      ({ HISTORY }) => {
        const raw = window.localStorage.getItem(HISTORY);
        const log = raw ? JSON.parse(raw) : [];
        const noise = Array.from({ length: 400 }, (_, i) => ({
          key: "noise-track",
          kind: i % 2 ? "play" : "pause",
          seconds: i,
          at: Date.now() + i * 10,
        }));
        window.localStorage.setItem(HISTORY, JSON.stringify([...noise.reverse(), ...log]));
      },
      { HISTORY },
    );

    // A real log write triggers the prune path.
    await receiveFromAccount(page, keyA!, 240, Date.now(), "Safari on iOS");

    await page.reload();
    await openRadio(page);
    await openSyncHistory(page);

    const rows = resolutions(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("4:00");
  });
});
