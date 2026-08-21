import { test, expect, type Page } from "@playwright/test";

/**
 * Latency and out-of-order delivery.
 *
 * Real account syncs arrive over a network: payloads are delayed by varying
 * amounts and can land in an order that has nothing to do with when the user
 * actually seeked. These scenarios push snapshots through the dev-only
 * `__hybridRadioAdoptRemote` hook behind randomised delays and assert the same
 * invariant every time — the resume point with the newest event time wins,
 * regardless of arrival order.
 */

const POSITIONS = "hybrid-radio-positions";
const TIMES = "hybrid-radio-position-times";
const DEVICES = "hybrid-radio-position-devices";

type Delivery = { seconds: number; at: number; device: string; delay: number };

async function openRadio(page: Page) {
  await page.goto("/");
  const title = page.getByTestId("radio-track-title");
  await expect(title).toBeVisible();
  await expect(title).not.toHaveText("—");
  await page.waitForFunction(() => "__hybridRadioAdoptRemote" in window && "__hybridRadioTrackKeys" in window, undefined, {
    timeout: 30_000,
  });
}

/** A track in the rotation that is not currently on air. */
async function queuedTrackKeys(page: Page) {
  const keys = await page.evaluate(
    () => (window as unknown as Record<string, string[]>)["__hybridRadioTrackKeys"] ?? [],
  );
  expect(keys.length).toBeGreaterThan(2);
  return keys.slice(1);
}

async function seedLocal(page: Page, key: string, seconds: number, at: number, device: string) {
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

/**
 * Fires every payload for a track at once, each behind its own latency, so
 * they land in delay order rather than the order they were created.
 */
async function deliverWithLatency(page: Page, key: string, deliveries: Delivery[]) {
  await page.evaluate(
    async ({ key, deliveries }) => {
      const adopt = (window as unknown as Record<string, (r: unknown) => void>)["__hybridRadioAdoptRemote"];
      await Promise.all(
        deliveries.map(
          (d) =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                adopt({
                  mixStyle: "artist",
                  shuffle: false,
                  spacing: 1,
                  mixSeed: 0,
                  trackKey: key,
                  queue: [],
                  positions: { [key]: d.seconds },
                  positionTimes: { [key]: d.at },
                  positionDevices: { [key]: d.device },
                  updatedAt: new Date(d.at).toISOString(),
                });
                resolve();
              }, d.delay),
            ),
        ),
      );
    },
    { key, deliveries },
  );
}

const savedPosition = (page: Page, key: string) =>
  page.evaluate(
    ({ key, POSITIONS }) => (JSON.parse(localStorage.getItem(POSITIONS) ?? "{}") as Record<string, number>)[key],
    { key, POSITIONS },
  );

const savedDevice = (page: Page, key: string) =>
  page.evaluate(
    ({ key, DEVICES }) => (JSON.parse(localStorage.getItem(DEVICES) ?? "{}") as Record<string, string>)[key],
    { key, DEVICES },
  );

test.describe("Hybrid AI Radio — latency and out-of-order sync", () => {
  test("the newest seek wins when the slowest payload is the newest one", async ({ page }) => {
    await openRadio(page);
    const [key] = await queuedTrackKeys(page);
    const now = Date.now();

    await seedLocal(page, key!, 12, now - 300_000, "Chrome on macOS");

    // Newest event, slowest network: it arrives last but must still win.
    await deliverWithLatency(page, key!, [
      { seconds: 60, at: now - 120_000, device: "Safari on iOS", delay: 10 },
      { seconds: 180, at: now - 30_000, device: "Pixel on Android", delay: 250 },
    ]);

    await expect.poll(() => savedPosition(page, key!)).toBe(180);
    expect(await savedDevice(page, key!)).toBe("Pixel on Android");
  });

  test("a fast stale payload arriving after the newest one never overwrites it", async ({ page }) => {
    await openRadio(page);
    const [key] = await queuedTrackKeys(page);
    const now = Date.now();

    await seedLocal(page, key!, 5, now - 400_000, "Chrome on macOS");

    // Newest lands first; two older payloads race in behind it.
    await deliverWithLatency(page, key!, [
      { seconds: 240, at: now - 5_000, device: "Pixel on Android", delay: 0 },
      { seconds: 90, at: now - 90_000, device: "Safari on iOS", delay: 80 },
      { seconds: 30, at: now - 200_000, device: "Fire TV", delay: 160 },
    ]);

    await expect.poll(() => savedPosition(page, key!)).toBe(240);
    expect(await savedDevice(page, key!)).toBe("Pixel on Android");
  });

  test("every arrival order of the same five payloads converges on the newest seek", async ({ page }) => {
    await openRadio(page);
    const [key] = await queuedTrackKeys(page);

    const orders = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [3, 4, 0, 2, 1],
    ];

    for (const order of orders) {
      const now = Date.now();
      const payloads: Delivery[] = [
        { seconds: 15, at: now - 500_000, device: "Fire TV", delay: 0 },
        { seconds: 45, at: now - 400_000, device: "Chrome on macOS", delay: 0 },
        { seconds: 95, at: now - 300_000, device: "Safari on iOS", delay: 0 },
        { seconds: 155, at: now - 200_000, device: "Pixel on Android", delay: 0 },
        { seconds: 275, at: now - 1_000, device: "Studio Mac", delay: 0 },
      ];

      // Reset the track, then deliver in this permutation with jittered latency.
      await seedLocal(page, key!, 1, now - 900_000, "Fire TV");
      await deliverWithLatency(
        page,
        key!,
        order.map((idx, position) => ({ ...payloads[idx]!, delay: position * 40 + (idx % 3) * 7 })),
      );

      await expect.poll(() => savedPosition(page, key!)).toBe(275);
      expect(await savedDevice(page, key!)).toBe("Studio Mac");
    }
  });

  test("interleaved late payloads across two tracks each keep their own newest seek", async ({ page }) => {
    await openRadio(page);
    const [keyA, keyB] = await queuedTrackKeys(page);
    const now = Date.now();

    await seedLocal(page, keyA!, 8, now - 600_000, "Fire TV");
    await seedLocal(page, keyB!, 8, now - 600_000, "Fire TV");

    // Track A's newest is slow; track B's newest is fast, chased by a stale one.
    await Promise.all([
      deliverWithLatency(page, keyA!, [
        { seconds: 70, at: now - 250_000, device: "Safari on iOS", delay: 20 },
        { seconds: 210, at: now - 10_000, device: "Studio Mac", delay: 300 },
      ]),
      deliverWithLatency(page, keyB!, [
        { seconds: 330, at: now - 4_000, device: "Pixel on Android", delay: 40 },
        { seconds: 120, at: now - 350_000, device: "Chrome on macOS", delay: 180 },
      ]),
    ]);

    await expect.poll(() => savedPosition(page, keyA!)).toBe(210);
    await expect.poll(() => savedPosition(page, keyB!)).toBe(330);
    expect(await savedDevice(page, keyA!)).toBe("Studio Mac");
    expect(await savedDevice(page, keyB!)).toBe("Pixel on Android");
  });

  test("the winning resume point survives a reload after out-of-order delivery", async ({ page }) => {
    await openRadio(page);
    const [key] = await queuedTrackKeys(page);
    const now = Date.now();

    await seedLocal(page, key!, 3, now - 700_000, "Fire TV");
    await deliverWithLatency(page, key!, [
      { seconds: 145, at: now - 8_000, device: "Studio Mac", delay: 30 },
      { seconds: 62, at: now - 300_000, device: "Safari on iOS", delay: 200 },
    ]);
    await expect.poll(() => savedPosition(page, key!)).toBe(145);

    await page.reload();
    await openRadio(page);

    expect(await savedPosition(page, key!)).toBe(145);
    expect(await savedDevice(page, key!)).toBe("Studio Mac");
  });
});
