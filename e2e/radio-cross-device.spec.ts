import { test, expect, type Page } from "@playwright/test";

/**
 * Cross-device resume-point resolution, end to end.
 *
 * Two isolated browser contexts stand in for two devices on the same account:
 * each has its own localStorage, so "device B" genuinely records its own
 * play/seek state. The account round-trip is short-circuited through the
 * dev-only `__hybridRadioAdoptRemote` hook, which hands device A exactly the
 * snapshot device B saved — the same shape `loadRadioSettings` returns — so
 * the real merge, resume and Sync History code paths run.
 *
 * The tests target a queued track rather than the one on air: the live track's
 * playhead is owned by the player itself, which would overwrite a seeded
 * resume point mid-test.
 */

const POSITIONS = "hybrid-radio-positions";
const TIMES = "hybrid-radio-position-times";
const DEVICES = "hybrid-radio-position-devices";
const HISTORY = "hybrid-radio-sync-history";

type Snapshot = {
  positions: Record<string, number>;
  positionTimes: Record<string, number>;
  positionDevices: Record<string, string>;
};

async function openRadio(page: Page) {
  await page.goto("/");
  const title = page.getByTestId("radio-track-title");
  await expect(title).toBeVisible();
  await expect(title).not.toHaveText("—");
  // The page is server-rendered; wait for hydration to install the test hooks.
  await page.waitForFunction(() => "__hybridRadioAdoptRemote" in window && "__hybridRadioTrackKeys" in window, undefined, {
    timeout: 30_000,
  });
}

/** A track in the rotation that is not currently on air. */
async function queuedTrackKey(page: Page) {
  const keys = await page.evaluate(
    () => (window as unknown as Record<string, string[]>)["__hybridRadioTrackKeys"] ?? [],
  );
  expect(keys.length).toBeGreaterThan(1);
  return keys[1]!;
}

/** Records a play/seek on this device exactly as the player persists one. */
async function recordSeek(page: Page, key: string, seconds: number, at: number, device: string) {
  await page.evaluate(
    ({ key, seconds, at, device, POSITIONS, TIMES, DEVICES, HISTORY }) => {
      const merge = (name: string, value: unknown) => {
        const raw = window.localStorage.getItem(name);
        const map = raw ? JSON.parse(raw) : {};
        map[key] = value;
        window.localStorage.setItem(name, JSON.stringify(map));
      };
      merge(POSITIONS, seconds);
      merge(TIMES, at);
      merge(DEVICES, device);
      const raw = window.localStorage.getItem(HISTORY);
      const log = raw ? JSON.parse(raw) : [];
      window.localStorage.setItem(HISTORY, JSON.stringify([{ key, kind: "seek", seconds, at }, ...log]));
    },
    { key, seconds, at, device, POSITIONS, TIMES, DEVICES, HISTORY },
  );
}

/** The snapshot this device would upload to the account. */
async function snapshot(page: Page, key: string): Promise<Snapshot> {
  return page.evaluate(
    ({ key, POSITIONS, TIMES, DEVICES }) => {
      const pick = (name: string) => {
        const raw = window.localStorage.getItem(name);
        const map = raw ? JSON.parse(raw) : {};
        return key in map ? { [key]: map[key] } : {};
      };
      return {
        positions: pick(POSITIONS),
        positionTimes: pick(TIMES),
        positionDevices: pick(DEVICES),
      };
    },
    { key, POSITIONS, TIMES, DEVICES },
  );
}

/** Hands an account snapshot to this device, as a sync from the other one. */
async function receiveFromAccount(page: Page, snap: Snapshot, trackKey: string) {
  await page.evaluate(
    ({ snap, trackKey }) => {
      const adopt = (window as unknown as Record<string, (r: unknown) => void>)["__hybridRadioAdoptRemote"];
      adopt({
        mixStyle: "artist",
        shuffle: false,
        spacing: 1,
        mixSeed: 0,
        trackKey,
        queue: [],
        ...snap,
        updatedAt: new Date().toISOString(),
      });
    },
    { snap, trackKey },
  );
}

async function openSyncHistory(page: Page) {
  await page.getByRole("button", { name: /Sync History/i }).click();
}

const resolutions = (page: Page) => page.getByTestId("radio-resolutions").locator("li");

const savedPosition = (page: Page, key: string) =>
  page.evaluate(
    ({ key, POSITIONS }) => (JSON.parse(localStorage.getItem(POSITIONS) ?? "{}") as Record<string, number>)[key],
    { key, POSITIONS },
  );

test.describe("Hybrid AI Radio — cross-device conflict resolution", () => {
  test("a newer seek on the second device wins and lands in Sync History", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const deviceA = await contextA.newPage();
    const deviceB = await contextB.newPage();
    await openRadio(deviceA);
    await openRadio(deviceB);

    const key = await queuedTrackKey(deviceA);
    const now = Date.now();

    // Device A left off early; device B seeked further, and more recently.
    await recordSeek(deviceA, key, 30, now - 60_000, "Chrome on macOS");
    await recordSeek(deviceB, key, 120, now - 1_000, "Safari on iOS");
    const fromB = await snapshot(deviceB, key);

    await openSyncHistory(deviceA);
    await expect(deviceA.getByText("No cross-device resolutions yet.")).toBeVisible();

    await receiveFromAccount(deviceA, fromB, key);

    const row = resolutions(deviceA).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("2:00");
    await expect(row).toContainText("Safari on iOS");

    // The winning value is what this device now resumes from.
    await expect.poll(() => savedPosition(deviceA, key)).toBe(120);

    await contextA.close();
    await contextB.close();
  });

  test("an out-of-order older payload never overwrites the newer local seek", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const deviceA = await contextA.newPage();
    const deviceB = await contextB.newPage();
    await openRadio(deviceA);
    await openRadio(deviceB);

    const key = await queuedTrackKey(deviceA);
    const now = Date.now();

    // Device B's seek happened first, but its payload arrives last.
    await recordSeek(deviceB, key, 15, now - 120_000, "Safari on iOS");
    await recordSeek(deviceA, key, 200, now - 1_000, "Chrome on macOS");
    const staleFromB = await snapshot(deviceB, key);

    await openSyncHistory(deviceA);
    await receiveFromAccount(deviceA, staleFromB, key);

    await expect(deviceA.getByText("No cross-device resolutions yet.")).toBeVisible();
    expect(await savedPosition(deviceA, key)).toBe(200);

    await contextA.close();
    await contextB.close();
  });

  test("replaying the same account payload does not add duplicate history entries", async ({ browser }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const deviceA = await contextA.newPage();
    const deviceB = await contextB.newPage();
    await openRadio(deviceA);
    await openRadio(deviceB);

    const key = await queuedTrackKey(deviceA);
    const now = Date.now();

    await recordSeek(deviceA, key, 10, now - 60_000, "Chrome on macOS");
    await recordSeek(deviceB, key, 90, now - 1_000, "Safari on iOS");
    const fromB = await snapshot(deviceB, key);

    await openSyncHistory(deviceA);
    await receiveFromAccount(deviceA, fromB, key);
    await expect(resolutions(deviceA)).toHaveCount(1);

    await receiveFromAccount(deviceA, fromB, key);
    await receiveFromAccount(deviceA, fromB, key);

    // Same track, same winning timestamp — one settled row, one logged event.
    await expect(resolutions(deviceA)).toHaveCount(1);
    const resolvedCount = await deviceA.evaluate((h) => {
      const log = JSON.parse(localStorage.getItem(h) ?? "[]") as { kind: string }[];
      return log.filter((e) => e.kind === "resolved").length;
    }, HISTORY);
    expect(resolvedCount).toBe(1);
    expect(await savedPosition(deviceA, key)).toBe(90);

    await contextA.close();
    await contextB.close();
  });
});
