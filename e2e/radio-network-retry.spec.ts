import { readFileSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import { toJSONAsync } from "seroval";

/**
 * Real network failure → retry → recovery, end to end.
 *
 * Unlike `radio-sync-failure.spec.ts` (which triggers the failure through a
 * dev hook), these tests break the actual account round-trip: a signed-in
 * session is planted so the console really calls the `loadRadioSettings`
 * server function, and Playwright aborts that request at the network layer.
 * Retry then re-issues the real request, which the recovered network answers
 * with a genuine server-function payload.
 *
 * What is asserted: the Sync History panel moves from the failure state to the
 * recovered state, and the Resolved Timestamps list keeps every device
 * resolution it already had, still newest-first, after the round trip.
 */

const HISTORY = "hybrid-radio-sync-history";
const FAILURES = "hybrid-radio-sync-failures";
const LOAD_FN = "loadRadioSettings";

/** Project ref for the auth storage key the Supabase client reads. */
const PROJECT_REF = (() => {
  const env = readFileSync(".env", "utf8");
  const match = env.match(/VITE_SUPABASE_PROJECT_ID="?([^"\n]+)"?/);
  return match?.[1]?.trim() ?? "";
})();
const AUTH_KEY = `sb-${PROJECT_REF}-auth-token`;

/** A session shaped like a signed-in listener, so the sync path actually runs. */
function fakeSession() {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  return JSON.stringify({
    access_token: "e2e.network.retry",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expires,
    refresh_token: "e2e-refresh",
    user: {
      id: "00000000-0000-0000-0000-0000000000e2",
      aud: "authenticated",
      role: "authenticated",
      email: "listener@hybridairecords.test",
      app_metadata: {},
      user_metadata: {},
      created_at: "2024-01-01T00:00:00.000Z",
    },
  });
}

type Snapshot = {
  positions: Record<string, number>;
  positionTimes: Record<string, number>;
  positionDevices: Record<string, string>;
};

/** Mutable network state shared with the route handler. */
type Net = { online: boolean; snapshot: Snapshot | null };

/** Serializes an account payload exactly the way the server function does. */
async function serverFnBody(snapshot: Snapshot | null) {
  const result = snapshot
    ? {
        mixStyle: "artist",
        shuffle: false,
        spacing: 1,
        mixSeed: 0,
        trackKey: null,
        queue: [],
        ...snapshot,
        updatedAt: new Date().toISOString(),
      }
    : null;
  const json = (await toJSONAsync({ result, context: {} })) as { t: unknown };
  return JSON.stringify(json.t);
}

/** Fails or answers the real account request depending on `net.online`. */
async function installAccountRoute(page: Page, net: Net) {
  await page.route("**/_serverFn/**", async (route: Route) => {
    const id = route.request().url().split("/_serverFn/")[1] ?? "";
    let decoded = "";
    try {
      decoded = Buffer.from(decodeURIComponent(id), "base64").toString("utf8");
    } catch {
      /* not a server-fn id we care about */
    }
    if (!decoded.includes(LOAD_FN)) return route.fallback();
    if (!net.online) return route.abort("failed");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-tss-serialized": "true" },
      body: await serverFnBody(net.snapshot),
    });
  });
}

async function openRadio(page: Page, net: Net) {
  await installAccountRoute(page, net);
  await page.goto("/");
  await page.evaluate(
    ([key, session, failures, history]) => {
      window.localStorage.setItem(key!, session!);
      window.localStorage.removeItem(failures!);
      window.localStorage.removeItem(history!);
    },
    [AUTH_KEY, fakeSession(), FAILURES, HISTORY],
  );
  // Reload so the client boots with the session in place. A racing in-flight
  // request can abort the navigation; one retry is enough.
  await page.reload({ waitUntil: "load" }).catch(() => page.reload({ waitUntil: "load" }));
  const title = page.getByTestId("radio-track-title");
  await expect(title).toBeVisible();
  await expect(title).not.toHaveText("—");
  await page.waitForFunction(() => "__hybridRadioTrackKeys" in window, undefined, { timeout: 30_000 });
}

/** Two tracks that are not on air, so the player can't move their playheads. */
async function queuedTrackKeys(page: Page) {
  const keys = await page.evaluate(
    () => (window as unknown as Record<string, string[]>)["__hybridRadioTrackKeys"] ?? [],
  );
  expect(keys.length).toBeGreaterThan(2);
  return [keys[1]!, keys[2]!] as const;
}

async function openHistoryPanel(page: Page) {
  await page.waitForFunction(() => "__hybridRadioTrackKeys" in window, undefined, { timeout: 30_000 });
  const chip = page.getByRole("button", { name: /sync history/i }).first();
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(page.getByText("Resolved Timestamps", { exact: true })).toBeVisible();
}

const failures = (page: Page) => page.getByTestId("radio-sync-failures");
const resolutionRows = (page: Page) => page.getByTestId("radio-resolutions").locator("li");

/** Writes a resolution the panel already had before the network broke. */
async function seedResolution(page: Page, key: string, seconds: number, at: number, device: string) {
  await page.evaluate(
    ({ key, seconds, at, device, HISTORY }) => {
      const raw = window.localStorage.getItem(HISTORY);
      const log = raw ? JSON.parse(raw) : [];
      window.localStorage.setItem(
        HISTORY,
        JSON.stringify([{ key, kind: "resolved", seconds, at, wonAt: at, device, winner: "remote" }, ...log]),
      );
      window.dispatchEvent(new CustomEvent("hybrid-radio-history"));
    },
    { key, seconds, at, device, HISTORY },
  );
}

test.describe("Hybrid AI Radio — network retry and recovery", () => {
  test("an aborted account request records a real failure in the panel", async ({ page }) => {
    const net: Net = { online: false, snapshot: null };
    await openRadio(page, net);
    await openHistoryPanel(page);

    await expect(failures(page)).toBeVisible();
    await expect(failures(page)).toContainText("Sync Failed");
    await expect(failures(page)).toContainText("Couldn't reach your account");
  });

  test("Retry over a recovered network clears the failure and resolves the account timestamps", async ({ page }) => {
    const net: Net = { online: false, snapshot: null };
    await openRadio(page, net);
    const [keyA] = await queuedTrackKeys(page);
    await openHistoryPanel(page);
    await expect(failures(page)).toBeVisible();

    // The network comes back and the account holds a newer seek from a phone.
    net.snapshot = {
      positions: { [keyA]: 132 },
      positionTimes: { [keyA]: Date.now() - 1000 },
      positionDevices: { [keyA]: "Safari on iOS" },
    };
    net.online = true;

    await page.getByTestId("radio-history-retry").click();

    await expect(failures(page)).toHaveCount(0);
    await expect(resolutionRows(page)).toHaveCount(1);
    await expect(resolutionRows(page).first()).toContainText("Safari on iOS");
    await expect(resolutionRows(page).first()).toContainText("2:12");
    await expect
      .poll(async () => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), FAILURES)) ?? "[]").length)
      .toBe(0);
  });

  test("recovery keeps earlier device resolutions and their newest-first order", async ({ page }) => {
    const net: Net = { online: false, snapshot: null };
    await openRadio(page, net);
    const [keyA, keyB] = await queuedTrackKeys(page);

    // Two resolutions already on the books before the outage.
    await seedResolution(page, keyA, 45, Date.now() - 600_000, "Chrome on macOS");
    await seedResolution(page, keyB, 90, Date.now() - 300_000, "Firefox on Windows");

    await openHistoryPanel(page);
    await expect(failures(page)).toBeVisible();
    await expect(resolutionRows(page)).toHaveCount(2);
    await expect(resolutionRows(page).first()).toContainText("Firefox on Windows");
    await expect(resolutionRows(page).nth(1)).toContainText("Chrome on macOS");

    // Network returns with a fresh, newer resolution for the older track.
    net.snapshot = {
      positions: { [keyA]: 210 },
      positionTimes: { [keyA]: Date.now() },
      positionDevices: { [keyA]: "Safari on iOS" },
    };
    net.online = true;
    await page.getByTestId("radio-history-retry").click();

    await expect(failures(page)).toHaveCount(0);
    // Nothing was dropped: still one row per track, newest resolution on top.
    await expect(resolutionRows(page)).toHaveCount(2);
    await expect(resolutionRows(page).first()).toContainText("Safari on iOS");
    await expect(resolutionRows(page).first()).toContainText("3:30");
    await expect(resolutionRows(page).nth(1)).toContainText("Firefox on Windows");
    await expect(resolutionRows(page).nth(1)).toContainText("1:30");
  });

  test("a retry while the network is still down records the failure again", async ({ page }) => {
    const net: Net = { online: false, snapshot: null };
    await openRadio(page, net);
    await openHistoryPanel(page);
    await expect(failures(page)).toBeVisible();

    await page.getByTestId("radio-history-retry").click();
    // Retry clears the recorded failures, then the second abort logs a new one.
    await expect(failures(page)).toBeVisible();
    await expect(failures(page)).toContainText("Couldn't reach your account");
    await expect
      .poll(async () => JSON.parse((await page.evaluate((k) => localStorage.getItem(k), FAILURES)) ?? "[]").length)
      .toBeGreaterThan(0);
  });

  test("the recovered state survives a reload with resolutions intact", async ({ page }) => {
    const net: Net = { online: false, snapshot: null };
    await openRadio(page, net);
    const [keyA] = await queuedTrackKeys(page);
    await openHistoryPanel(page);
    await expect(failures(page)).toBeVisible();

    net.snapshot = {
      positions: { [keyA]: 77 },
      positionTimes: { [keyA]: Date.now() },
      positionDevices: { [keyA]: "Edge on Windows" },
    };
    net.online = true;
    await page.getByTestId("radio-history-retry").click();
    await expect(failures(page)).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("radio-track-title")).not.toHaveText("—");
    await openHistoryPanel(page);
    await expect(failures(page)).toHaveCount(0);
    await expect(resolutionRows(page).first()).toContainText("Edge on Windows");
    await expect(resolutionRows(page).first()).toContainText("1:17");
  });
});
