import { devices, expect, test, type Page, type Route } from "@playwright/test";

/**
 * iOS Safari / WebKit emulation — Hybrid Engine mobile smoke.
 *
 * Emulates iPhone 14 (390×844). Runs on `mobile-safari` when WebKit is usable
 * (`PLAYWRIGHT_FORCE_WEBKIT=1` or a protocol-compatible build) and on
 * `mobile-chrome` via the `*.mobile.spec.ts` project match.
 *
 * Physical-device Files.app download landing remains a manual 30s check.
 */

test.use({
  ...devices["iPhone 14"],
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

const TITLE = "iOS Safari Smoke";
const LYRICS = "[Verse]\nNight drive on wet asphalt\n[Chorus]\nKeep the engine humming";

function watchPageFaults(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
    failedRequests.push(`${request.method()} ${request.url()} (${failure})`);
  });

  return { pageErrors, consoleErrors, failedRequests };
}

function fatalClientFaults(errors: string[]) {
  return errors.filter(
    (e) =>
      // Vite cold-start / HMR noise on WebKit — ignore when paint stays healthy.
      !/Importing a module script failed/i.test(e) &&
      /ReferenceError|TypeError|Minified React error|Hydration failed|did not match|removeChild|is not a function|undefined is not an object|Maximum update depth/i.test(
        e,
      ),
  );
}

async function expectHealthyPaint(page: Page, label: string) {
  await page.waitForLoadState("domcontentloaded");
  const painted = await page.evaluate(() => document.body?.innerText.trim().length ?? 0);
  expect(painted, `${label}: blank / white screen`).toBeGreaterThan(40);
  await expect(
    page.getByText("Something interrupted the page"),
    `${label}: AppErrorBoundary visible`,
  ).toHaveCount(0);
  await expect(
    page.getByText("This panel hit a snag"),
    `${label}: StudioErrorBoundary visible`,
  ).toHaveCount(0);
}

/** Opaque Token Store panel — no translucent bleed of the living mesh. */
async function expectOpaqueModalPanel(page: Page, label: string) {
  const dialog = page.locator("[role='dialog']:visible").first();
  await expect(dialog, `${label}: dialog visible`).toBeVisible();

  const panel = dialog.locator(".modal-panel-solid").first();
  const target = (await panel.count()) > 0 ? panel : dialog;

  const styles = await target.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      opacity: cs.opacity,
      backgroundColor: cs.backgroundColor,
      backdropFilter:
        cs.backdropFilter ||
        (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        "none",
      backgroundImage: cs.backgroundImage,
    };
  });

  expect(Number(styles.opacity), `${label}: panel opacity`).toBeGreaterThanOrEqual(0.99);
  expect(
    styles.backdropFilter === "none" || styles.backdropFilter === "",
    `${label}: no blur bleed`,
  ).toBe(true);
  expect(
    styles.backgroundImage === "none" || styles.backgroundImage === "",
    `${label}: solid fill`,
  ).toBe(true);
  expect(styles.backgroundColor, `${label}: solid zinc background`).toMatch(
    /rgba?\(\s*9\s*,\s*9\s*,\s*11/i,
  );
}

async function mockEngine(page: Page) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/studio/generate-stream", async (route) => {
    const body = [
      "event: progress",
      'data: {"stage":"composition","percent":28}',
      "",
      "event: result",
      `data: ${JSON.stringify({
        taskId: "task_ios_smoke",
        tracks: [
          {
            id: "trk_ios",
            title: TITLE,
            audioUrl: "https://example.invalid/ios-smoke.mp3",
            duration: 90,
          },
        ],
        gateMask: 63,
        tokenSettled: true,
      })}`,
      "",
    ].join("\n");
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body,
    });
  });

  await page.route("**/_serverFn/**", async (route) => {
    const url = route.request().url();
    const payload = route.request().postData() ?? "";
    if (/health|checkEngineHealth/i.test(url) || /checkEngineHealth/i.test(payload)) {
      return json(route, { creditsExhausted: false, ok: true });
    }
    if (/getTokenBalance/i.test(url) || /getTokenBalance/i.test(payload)) {
      return json(route, { balance: 2 });
    }
    if (/spendTokens/i.test(url) || /spendTokens/i.test(payload)) {
      return json(route, { ok: true, balance: 1, alreadyApplied: false });
    }
    return route.fallback();
  });

  await page.route("https://example.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/mpeg", body: Buffer.from("ID3") }),
  );
}

/** Walk the 4-step composer to the Generate Track control. */
async function reachGenerateStep(page: Page) {
  const titleBox = page.getByPlaceholder("Enter your track title");
  const lyricsBox = page.getByPlaceholder(/Enter your custom lyrics/i);
  await expect(titleBox).toBeVisible({ timeout: 20_000 });

  await titleBox.click();
  await titleBox.fill("");
  await titleBox.pressSequentially(TITLE, { delay: 15 });
  await lyricsBox.click();
  await lyricsBox.fill("");
  await lyricsBox.pressSequentially(LYRICS, { delay: 5 });
  await lyricsBox.blur();

  const continueStep2 = page.getByRole("button", { name: /Continue to Step 2/i });
  await expect(continueStep2).toBeEnabled({ timeout: 10_000 });
  await continueStep2.click();

  const genreChip = page
    .locator("button")
    .filter({ hasText: /Hip.?Hop|Pop|Rock|Electronic|Trap/i })
    .first();
  if (await genreChip.isVisible().catch(() => false)) {
    await genreChip.click().catch(() => undefined);
  }
  await page.getByRole("button", { name: /^Continue$/i }).click();
  await page.getByRole("button", { name: /^Continue$/i }).click();

  await expect(page.getByRole("button", { name: /Generate Track/i })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("iOS Safari / WebKit hybrid smoke", () => {
  test.describe.configure({ timeout: 120_000 });

  test("home + portal paint cleanly on iPhone 14 profile", async ({ page }) => {
    const faults = watchPageFaults(page);

    for (const route of ["/", "/portal"] as const) {
      await page.goto(route, { waitUntil: "networkidle" }).catch(async () => {
        await page.goto(route, { waitUntil: "domcontentloaded" });
      });
      await page.waitForTimeout(800);
      await expectHealthyPaint(page, route);
    }

    expect(fatalClientFaults(faults.pageErrors), "pageerrors").toEqual([]);
    expect(fatalClientFaults(faults.consoleErrors), "console errors").toEqual([]);
  });

  test("Hybrid Token Store modal is fully opaque on mobile Safari", async ({ page }) => {
    const faults = watchPageFaults(page);

    await page.addInitScript(() => {
      try {
        window.sessionStorage.setItem("har:e2e:force-token-store", "1");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/engine", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Hybrid Token Store/i })).toBeVisible({
      timeout: 20_000,
    });
    await expectOpaqueModalPanel(page, "Hybrid Token Store");

    expect(fatalClientFaults(faults.pageErrors)).toEqual([]);
    expect(fatalClientFaults(faults.consoleErrors)).toEqual([]);
  });

  test("mocked generation on /engine does not crash mobile Safari view", async ({ page }) => {
    const faults = watchPageFaults(page);
    await mockEngine(page);

    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("hybrid:allowTokenless", "1");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/engine", { waitUntil: "domcontentloaded" });
    await expectHealthyPaint(page, "/engine initial");
    await reachGenerateStep(page);

    await page.getByRole("button", { name: /Generate Track/i }).click();
    await page.waitForTimeout(2_500);
    await expectHealthyPaint(page, "/engine after generate");

    const fatals = [
      ...fatalClientFaults(faults.pageErrors),
      ...fatalClientFaults(faults.consoleErrors),
    ];
    expect(fatals, `fatal faults:\n${fatals.join("\n")}`).toEqual([]);

    if (faults.failedRequests.length) {
      console.warn("[ios-safari-smoke] requestfailed:", faults.failedRequests.slice(0, 12));
    }
    if (faults.consoleErrors.length) {
      console.warn("[ios-safari-smoke] console errors:", faults.consoleErrors.slice(0, 12));
    }
  });
});
