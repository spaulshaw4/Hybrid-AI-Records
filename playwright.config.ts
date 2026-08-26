import { existsSync, readFileSync, readdirSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/** First existing path in the list, or undefined. */
const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p));

/** Every `<store-path>/<suffix>` match in the Nix store (empty off-Nix). */
function nixStorePaths(match: RegExp, suffix: string) {
  if (!existsSync("/nix/store")) return [];
  return readdirSync("/nix/store")
    .filter((entry) => match.test(entry))
    .map((entry) => `/nix/store/${entry}/${suffix}`)
    .filter((p) => existsSync(p));
}

/**
 * Sandbox/CI images may ship a prebuilt Chromium that doesn't match the
 * @playwright/test download revision — and the Nix image keeps it in the store
 * rather than the standard download dir. Prefer an explicit binary when present.
 */
const CHROMIUM_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  firstExisting([
    "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
    "/opt/ms-playwright/chromium-1234/chrome-linux/chrome",
    ...nixStorePaths(/-playwright-chromium$/, "chrome-linux/chrome"),
  ]);

/**
 * WebKit: the downloadable build links against GTK/ATK that Nix sandboxes don't
 * expose, so prefer the image's own WebKit when the standard one is unusable.
 * Note its protocol can predate this @playwright/test release — see
 * e2e/tools/gen-safari-snapshots.py for how iOS baselines are refreshed here.
 */
const WEBKIT_PATH =
  process.env.PLAYWRIGHT_WEBKIT_PATH ??
  firstExisting([
    "/opt/ms-playwright/webkit-2215/pw_run.sh",
    "/opt/ms-playwright/webkit_ubuntu20.04_x64_special-2092/pw_run.sh",
  ]);

/**
 * The image's WebKit can predate this @playwright/test release, in which case
 * every context creation dies with `Unknown setting: PushAPIEnabled` before a
 * single assertion runs. Detect that up front and drop the iOS project instead
 * of reporting 149 phantom failures; mobile-chrome still covers touch specs.
 */
const WEBKIT_PROTOCOL = WEBKIT_PATH?.replace(/pw_run\.sh$/, "protocol.json");
const WEBKIT_USABLE =
  process.env.PLAYWRIGHT_FORCE_WEBKIT === "1" ||
  (!WEBKIT_PATH
    ? process.env.PLAYWRIGHT_FORCE_WEBKIT !== "0"
    : !!WEBKIT_PROTOCOL &&
      existsSync(WEBKIT_PROTOCOL) &&
      readFileSync(WEBKIT_PROTOCOL, "utf8").includes("PushAPIEnabled"));

if (!WEBKIT_USABLE) {
  console.warn(
    "[playwright] Skipping the mobile-safari project: the installed WebKit build is older than this @playwright/test release (no PushAPIEnabled setting).",
  );
}


/**
 * Some sandboxes need an explicit shared-library path for the browser process.
 * Provide it via env or a local `.playwright-ld-library-path` file.
 */
const LD_PATH =
  process.env.PLAYWRIGHT_LD_LIBRARY_PATH ??
  (existsSync(".playwright-ld-library-path")
    ? readFileSync(".playwright-ld-library-path", "utf8").trim()
    : undefined);

const browserEnv = LD_PATH
  ? { env: { ...process.env, LD_LIBRARY_PATH: `${LD_PATH}:${process.env.LD_LIBRARY_PATH ?? ""}` } }
  : {};




/** E2E config — runs against the already-running dev server when present. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8080",
    viewport: { width: 1280, height: 1800 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /.*mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { ...browserEnv, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) },
      },
    },
    {
      // Touch-enabled phone profile for mobile-interaction specs.
      name: "mobile-chrome",
      testMatch: /.*mobile\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        launchOptions: { ...browserEnv, ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}) },
      },
    },
    ...(WEBKIT_USABLE
      ? [
          {
            // Touch-enabled iOS/WebKit profile — cross-engine parity for mobile specs.
            name: "mobile-safari",
            testMatch: /.*mobile\.spec\.ts/,
            use: {
              ...devices["iPhone 14"],
              viewport: { width: 390, height: 844 },
              isMobile: true,
              hasTouch: true,
              launchOptions: {
                ...browserEnv,
                ...(WEBKIT_PATH ? { executablePath: WEBKIT_PATH } : {}),
              },
            },
          },
        ]
      : []),
  ],


  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "bun run dev",
        url: "http://localhost:8080",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
