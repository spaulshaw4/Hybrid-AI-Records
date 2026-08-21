import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Hydration stress regression (iOS Safari / WebKit profile).
 *
 * Intermittent white screens on iOS came from hydration and session-state
 * churn under load: repeated generation attempts, sessionStorage draft writes,
 * and visibility/pagehide cycles while React was still hydrating. A single
 * happy-path pass never reproduced it, so this spec *repeats* the heavy path
 * many times and asserts, every cycle, that the app is still painted, the
 * global error boundary never took over, and no hydration mismatch or render
 * crash was logged.
 *
 * Generation is fully mocked at the server-function boundary: the point is the
 * client's hydration/state behaviour, not the audio vendor.
 */

const TITLE = "Hydration Stress";
const PROMPT = "Heavy crimson trap with distorted 808s, tape hiss and a gospel outro.";
const CYCLES = Number(process.env.E2E_HYDRATION_CYCLES ?? 6);

const titleField = (page: Page) => page.getByPlaceholder("Name your track");
const promptField = (page: Page) =>
  page.getByPlaceholder("Describe the song, mood or story you want.");

/** Canned engine responses so a cycle costs nothing and never flakes on vendor latency. */
async function mockEngine(page: Page) {
  let polls = 0;
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/_serverFn/**", async (route) => {
    const url = route.request().url();
    if (!/apiframe-music/i.test(url)) return route.fallback();
    const payload = route.request().postData() ?? "";

    if (/health/i.test(url) || /checkEngineHealth/i.test(payload)) {
      return json(route, { creditsExhausted: false, ok: true });
    }
    if (/taskId/i.test(payload)) {
      polls += 1;
      // Two pending polls, then a finished track — the real heavy path.
      return json(route, {
        taskId: "task_stress",
        status: polls < 3 ? "processing" : "complete",
        tracks:
          polls < 3
            ? []
            : [
                {
                  id: "trk_stress",
                  title: TITLE,
                  audioUrl: "https://example.invalid/stress.mp3",
                  duration: 120,
                },
              ],
        correlationId: "poll_stress",
      });
    }
    return json(route, {
      taskId: "task_stress",
      status: "processing",
      tracks: [],
      correlationId: "gen_stress",
    });
  });

  // Never fetch the fake audio file itself.
  await page.route("https://example.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "audio/mpeg", body: "" }),
  );
}

/** Collects render-level failures; hydration mismatches included. */
function watchForCrashes(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function renderFailures(errors: string[]) {
  return errors.filter((e) =>
    /Minified React error|Hydration failed|did not match|Text content does not match|removeChild|is not a function/i.test(
      e,
    ),
  );
}

/** The page actually painted content and the error boundary is not showing. */
async function expectHealthyScreen(page: Page, cycle: number) {
  const painted = await page.evaluate(() => document.body?.innerText.trim().length ?? 0);
  expect(painted, `cycle ${cycle}: blank screen`).toBeGreaterThan(40);
  await expect(
    page.getByText("Something interrupted the page"),
    `cycle ${cycle}: error boundary rendered`,
  ).toHaveCount(0);
}

/** The lifecycle events iOS emits when it suspends or restores a tab. */
async function churnSession(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("resume"));
    window.dispatchEvent(new Event("resize"));
  });
}

test.describe("engine hydration stress", () => {
  test.slow();

  test("repeated generation + session churn never blank-screens", async ({ page }) => {
    const errors = watchForCrashes(page);
    await mockEngine(page);

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      await page.goto("/engine", { waitUntil: "domcontentloaded" });
      await expect(titleField(page)).toBeVisible();

      // Type immediately — the pre-hydration window is where mismatches bite.
      await titleField(page).fill(`${TITLE} ${cycle}`);
      await promptField(page).fill(PROMPT);
      await promptField(page).blur();

      // Kick a generation (mocked) and immediately churn the session while the
      // poller is running, which is exactly the iOS crash shape.
      const generate = page.getByRole("button", { name: /Generate/i }).first();
      if (await generate.isVisible().catch(() => false)) {
        await generate.click({ trial: false }).catch(() => undefined);
      }
      await page.waitForTimeout(300);
      await churnSession(page);
      await page.waitForTimeout(300);
      await expectHealthyScreen(page, cycle);

      // Memory-eviction style reload mid-run, then back again.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(titleField(page)).toBeVisible();
      await expectHealthyScreen(page, cycle);
    }

    expect(renderFailures(errors)).toEqual([]);
  });

  test("rapid control updates during hydration keep the composer mounted", async ({ page }) => {
    const errors = watchForCrashes(page);
    await mockEngine(page);

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      await page.goto("/engine", { waitUntil: "domcontentloaded" });
      // No wait for hydration on purpose: hammer state as the tree comes alive.
      for (let i = 0; i < 6; i += 1) {
        await titleField(page)
          .fill(`${TITLE} ${cycle}-${i}`)
          .catch(() => undefined);
      }
      await churnSession(page);
      await expect(titleField(page)).toBeVisible();
      await expectHealthyScreen(page, cycle);
    }

    expect(renderFailures(errors)).toEqual([]);
  });

  test("no fatal client errors were recorded in the local diagnostics log", async ({ page }) => {
    await mockEngine(page);
    await page.goto("/engine", { waitUntil: "domcontentloaded" });
    await expect(titleField(page)).toBeVisible();
    await churnSession(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(titleField(page)).toBeVisible();
    await page.waitForTimeout(3_000); // let the white-screen watcher settle

    const recorded = await page.evaluate(() => {
      try {
        return JSON.parse(window.localStorage.getItem("har_client_errors_v1") ?? "[]") as Array<{
          source: string;
          message: string;
        }>;
      } catch {
        return [];
      }
    });
    expect(
      recorded.filter((e) => /white-screen|app_error_boundary/i.test(e.source)).map((e) => e.message),
    ).toEqual([]);
  });
});
