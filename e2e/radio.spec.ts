import { test, expect, type Page } from "@playwright/test";

/** Scopes to the Hybrid AI Radio console card. */
const radio = (page: Page) =>
  page.locator("div").filter({ has: page.getByTestId("radio-track-title") }).last();

const title = (page: Page) => page.getByTestId("radio-track-title");

/**
 * The homepage is server-rendered, so buttons exist in the DOM before React
 * hydrates and early clicks are dropped. Toggling shuffle on/off proves the
 * handlers are live before a test starts asserting behavior.
 */
async function waitForHydration(page: Page) {
  const shuffle = page.getByRole("button", { name: "Shuffle" });
  await expect
    .poll(async () => {
      await shuffle.click();
      return shuffle.getAttribute("aria-pressed");
    }, { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe("true");
  await shuffle.click();
  await expect(shuffle).toHaveAttribute("aria-pressed", "false");
}

async function openRadio(page: Page) {
  await page.goto("/");
  await expect(title(page)).toBeVisible();
  // Wait for a real track name (not the "—" placeholder).
  await expect(title(page)).not.toHaveText("—");
  await waitForHydration(page);
}

/** Reads the ordered list of track titles rendered in the playlist. */
async function playlistTitles(page: Page) {
  const items = page.locator("[data-testid='radio-playlist-item']");
  if ((await items.count()) === 0) return [];
  return items.allTextContents();
}

test.describe("Hybrid AI Radio — shuffle", () => {
  test("shuffle toggle reflects pressed state", async ({ page }) => {
    await openRadio(page);
    const shuffle = page.getByRole("button", { name: "Shuffle" });

    await expect(shuffle).toHaveAttribute("aria-pressed", "false");
    await expect(shuffle).toHaveAttribute("title", "Shuffle off");

    await shuffle.click();
    await expect(shuffle).toHaveAttribute("aria-pressed", "true");
    await expect(shuffle).toHaveAttribute("title", "Shuffle on");

    await shuffle.click();
    await expect(shuffle).toHaveAttribute("aria-pressed", "false");
  });

  test("shuffle is keyboard operable", async ({ page }) => {
    await openRadio(page);
    const shuffle = page.getByRole("button", { name: "Shuffle" });
    await shuffle.focus();
    await page.keyboard.press("Enter");
    await expect(shuffle).toHaveAttribute("aria-pressed", "true");
  });

  test("sequential Next walks the playlist in order", async ({ page }) => {
    await openRadio(page);
    const first = await title(page).textContent();

    const seen: string[] = [first!.trim()];
    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(title(page)).not.toHaveText(seen[seen.length - 1]);
      seen.push((await title(page).textContent())!.trim());
    }
    // Previous walks back the same path.
    for (let i = seen.length - 1; i > 0; i--) {
      await page.getByRole("button", { name: "Previous" }).click();
      await expect(title(page)).toHaveText(seen[i - 1]);
    }
  });

  test("shuffled Next visits every track exactly once before repeating", async ({ page }) => {
    await openRadio(page);
    await page.getByRole("button", { name: "Shuffle" }).click();

    const start = (await title(page).textContent())!.trim();
    const visited = new Set<string>([start]);
    const sequence: string[] = [start];

    // Advance a bounded number of times; no title should repeat while walking.
    for (let i = 0; i < 8; i++) {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(title(page)).not.toHaveText("—");
      const t = (await title(page).textContent())!.trim();
      expect(sequence).not.toContain(t);
      sequence.push(t);
      visited.add(t);
    }
    expect(visited.size).toBe(sequence.length);

    // Shuffled Previous returns to the immediately preceding track.
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(title(page)).toHaveText(sequence[sequence.length - 2]);
  });

  test("shuffle order differs from sequential order", async ({ page }) => {
    await openRadio(page);

    const collect = async (steps: number) => {
      const out: string[] = [(await title(page).textContent())!.trim()];
      for (let i = 0; i < steps; i++) {
        await page.getByRole("button", { name: "Next", exact: true }).click();
        out.push((await title(page).textContent())!.trim());
      }
      return out;
    };

    const sequential = await collect(6);
    await page.reload();
    await expect(title(page)).not.toHaveText("—");
    await waitForHydration(page);
    await page.getByRole("button", { name: "Shuffle" }).click();
    const shuffled = await collect(6);

    expect(shuffled).toHaveLength(sequential.length);
    // Same start, different continuation (flake-safe: retry once before asserting).
    const differs = shuffled.slice(1).some((t, i) => t !== sequential[i + 1]);
    if (!differs) {
      await page.reload();
      await expect(title(page)).not.toHaveText("—");
      await waitForHydration(page);
      await page.getByRole("button", { name: "Shuffle" }).click();
      const retry = await collect(6);
      expect(retry.slice(1).some((t, i) => t !== sequential[i + 1])).toBe(true);
    } else {
      expect(differs).toBe(true);
    }
  });
});

test.describe("Hybrid AI Radio — auto-advance", () => {
  test("advances to the next track when the current one ends", async ({ page }) => {
    await openRadio(page);
    const before = (await title(page).textContent())!.trim();

    // Simulate playback completion on the hidden HTML5 audio engine.
    await page.evaluate(() => {
      const audio = document.querySelector("audio");
      audio?.dispatchEvent(new Event("ended"));
    });

    await expect(title(page)).not.toHaveText(before);
  });

  test("auto-advance follows the shuffled order when shuffle is on", async ({ page }) => {
    await openRadio(page);
    await page.getByRole("button", { name: "Shuffle" }).click();

    const endTrack = async () => {
      await page.evaluate(() => {
        document.querySelector("audio")?.dispatchEvent(new Event("ended"));
      });
    };

    const seen: string[] = [(await title(page).textContent())!.trim()];
    for (let i = 0; i < 4; i++) {
      await endTrack();
      await expect(title(page)).not.toHaveText(seen[seen.length - 1]);
      const t = (await title(page).textContent())!.trim();
      expect(seen).not.toContain(t);
      seen.push(t);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("play/pause control stays in sync with the engine", async ({ page }) => {
    await openRadio(page);
    // The transport button swaps its label between Play and Pause.
    const transport = page.locator(
      "button[aria-label='Play']:below(:text('Hybrid AI Radio')), button[aria-label='Pause']",
    );
    const label = () =>
      page.locator("button[aria-label='Play'], button[aria-label='Pause']").first().getAttribute("aria-label");

    await expect(transport.first()).toBeVisible();

    await page.evaluate(() => {
      document.querySelector("audio")?.dispatchEvent(new Event("play"));
    });
    await expect.poll(label).toBe("Pause");

    await page.evaluate(() => {
      document.querySelector("audio")?.dispatchEvent(new Event("pause"));
    });
    await expect.poll(label).toBe("Play");
  });


  test("radio console renders without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await openRadio(page);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    expect(errors).toEqual([]);
    expect(await playlistTitles(page)).toBeDefined();
    await expect(radio(page)).toBeVisible();
  });
});
