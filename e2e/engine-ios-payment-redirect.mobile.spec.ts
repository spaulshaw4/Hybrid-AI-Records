import { expect, test, type Page } from "@playwright/test";

/**
 * iOS Safari/WebKit payment-redirect resilience.
 *
 * On iOS, a Stripe/token gateway hop (or an OAuth round-trip) can discard the
 * whole page: the tab comes back as a fresh mount, which used to wipe the
 * composer and — worse — occasionally paint nothing at all ("white screen").
 * These specs drive the real redirect shapes and assert the studio always
 * comes back mounted, painted, and with the artist's inputs restored from the
 * sessionStorage draft written by `src/lib/engine-draft.ts`.
 */

const TITLE = "Redirect Survivor";
const PROMPT = "Slow crimson trap ballad with analog tape hiss and a gospel outro.";

const titleField = (page: Page) => page.getByPlaceholder("Name your track");
const promptField = (page: Page) => page.getByPlaceholder("Describe the song, mood or story you want.");

/** Opens the engine and waits for the composer to be interactive. */
async function openEngine(page: Page) {
  await page.goto("/engine", { waitUntil: "domcontentloaded" });
  await expect(titleField(page)).toBeVisible();
}

/**
 * Types the composer inputs an artist would lose on an unmount.
 *
 * Typing is retried until the value sticks *and* reaches the session draft:
 * the SSR markup is interactive before React hydrates, and anything typed in
 * that window is discarded by hydration — the same race an artist hits when
 * they tap straight into the composer on a cold iOS load.
 */
async function fillComposer(page: Page) {
  await expect(async () => {
    await titleField(page).fill(TITLE);
    await promptField(page).fill(PROMPT);
    await promptField(page).blur();
    const draft = await page.evaluate(() => window.sessionStorage.getItem("har:engine-draft:v1"));
    expect(draft ?? "").toContain(TITLE);
  }).toPass({ timeout: 20_000 });
}


/**
 * Fires the lifecycle events iOS emits right before it tears a page down for
 * an external redirect. Without these the draft would never be flushed.
 */
async function simulateIosSuspend(page: Page) {
  await page.evaluate(() => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
  });
}

/** The page painted something — the white-screen guard. */
async function expectPainted(page: Page) {
  await expect(page.locator("#app, body")).toBeVisible();
  const painted = await page.evaluate(() => {
    const root = document.body;
    return root ? root.innerText.trim().length : 0;
  });
  expect(painted).toBeGreaterThan(40);
}

/** Console/page errors that would indicate an unhandled render crash. */
function watchForCrashes(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

// The Vite dev server hydrates slowly under parallel load; these specs depend
// on hydration timing, so run them one at a time.
test.describe.configure({ mode: "serial" });

test.describe("iOS payment redirect — studio state survives", () => {
  test("restores the composer after a token-checkout redirect round-trip", async ({ page }) => {
    const errors = watchForCrashes(page);
    await openEngine(page);
    await fillComposer(page);
    await simulateIosSuspend(page);

    // Leave for the gateway, then come back the way Stripe returns the user.
    await page.goto("/tokens", { waitUntil: "domcontentloaded" });
    await page.goto("/engine?checkout=success&session_id=cs_test_ios_1", {
      waitUntil: "domcontentloaded",
    });

    await expectPainted(page);
    await expect(titleField(page)).toHaveValue(TITLE);
    await expect(promptField(page)).toHaveValue(PROMPT);
    expect(errors.filter((e) => /Minified React error|is not a function|undefined/i.test(e))).toEqual([]);
  });

  test("survives an external gateway origin hop without white-screening", async ({ page }) => {
    const errors = watchForCrashes(page);
    await openEngine(page);
    await fillComposer(page);
    await simulateIosSuspend(page);

    // A real off-origin hop (blocked to keep the test hermetic), then return.
    await page.route("https://checkout.stripe.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>gateway</body></html>" }),
    );
    await page.goto("https://checkout.stripe.com/c/pay/cs_test_ios_2", {
      waitUntil: "domcontentloaded",
    });
    await page.goBack({ waitUntil: "domcontentloaded" });

    await expectPainted(page);
    await expect(titleField(page)).toHaveValue(TITLE);
    expect(errors.filter((e) => /Minified React error/i.test(e))).toEqual([]);
  });

  test("restores after an iOS memory-eviction style reload of the same URL", async ({ page }) => {
    await openEngine(page);
    await fillComposer(page);
    await simulateIosSuspend(page);

    await page.reload({ waitUntil: "domcontentloaded" });

    await expectPainted(page);
    await expect(titleField(page)).toHaveValue(TITLE);
    await expect(promptField(page)).toHaveValue(PROMPT);
  });

  test("keeps a full-height layout after the redirect (no dvh reflow collapse)", async ({ page }) => {
    await openEngine(page);
    await fillComposer(page);
    await simulateIosSuspend(page);
    await page.goto("/engine?checkout=success", { waitUntil: "domcontentloaded" });

    const { docHeight, viewportHeight } = await page.evaluate(() => ({
      docHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    }));
    expect(docHeight).toBeGreaterThanOrEqual(viewportHeight * 0.9);
  });

  test("does not leak the draft into a brand-new session (fresh tab starts empty)", async ({
    browser,
  }) => {
    const first = await browser.newContext();
    const page = await first.newPage();
    await openEngine(page);
    await fillComposer(page);
    await simulateIosSuspend(page);
    await first.close();

    const second = await browser.newContext();
    const fresh = await second.newPage();
    await openEngine(fresh);
    await expect(titleField(fresh)).toHaveValue("");
    await second.close();
  });
});
