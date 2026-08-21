import { test, expect, type Page } from "@playwright/test";

/**
 * VoiceOver (iOS) coverage for the sync badge.
 *
 * VoiceOver itself can't be driven from Playwright, so this spec models the
 * three things iOS VoiceOver actually does with an element, using the same
 * inputs VoiceOver consumes (WebKit + the iPhone touch profile):
 *
 *  1. Swipe right / left moves the VO cursor through the accessibility tree in
 *     DOM order, skipping aria-hidden and presentational nodes.
 *  2. On landing, VO speaks: accessible name, then role, then state
 *     ("dimmed" for aria-disabled, "busy" for aria-busy), then the description
 *     resolved through aria-describedby (which is how the tooltip copy reaches
 *     a VoiceOver user — the visual TooltipContent is aria-hidden on purpose).
 *  3. Double-tap activates whatever the VO cursor is on, which dispatches a
 *     plain click on that element.
 *
 * Everything is asserted through computed ARIA, never CSS or visual chip text.
 */

const LAB = "/dev/sync-badge-lab";

type Utterance = {
  name: string;
  role: string;
  states: string[];
  description: string;
  live: string;
};

/** Anything VoiceOver would land on inside the badge stage, in swipe order. */
const VO_QUERY = "[data-testid='lab-badge'] [role='status'], [data-testid='lab-badge'] [role='alert'], [data-testid='lab-badge'] button";

async function openLab(page: Page) {
  await page.goto(LAB);
  await expect(page.getByRole("heading", { name: "Sync badge lab" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Installs the VO-cursor model in the page. */
async function installVoiceOver(page: Page) {
  await page.evaluate((selector) => {
    const w = window as unknown as Record<string, unknown>;

    const visible = (el: Element) =>
      !el.closest("[aria-hidden='true']") && (el as HTMLElement).offsetParent !== null;

    const textOf = (el: Element) =>
      (el.textContent ?? "").replace(/\s+/g, " ").trim();

    /** aria-label wins, else the element's own text, minus aria-hidden chrome. */
    const accName = (el: Element) => {
      const labelled = el.getAttribute("aria-label");
      if (labelled) return labelled.replace(/\s+/g, " ").trim();
      const clone = el.cloneNode(true) as Element;
      clone.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
      clone.querySelectorAll("button").forEach((n) => n.remove());
      return textOf(clone);
    };

    /** aria-describedby → the sentence VoiceOver appends after the role. */
    const accDescription = (el: Element) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      return ids
        .map((id) => textOf(document.getElementById(id) ?? document.createElement("span")))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    };

    const roleOf = (el: Element) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      return el.tagName === "BUTTON" ? "button" : "";
    };

    const statesOf = (el: Element) => {
      const states: string[] = [];
      if (el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) states.push("dimmed");
      if (el.getAttribute("aria-busy") === "true") states.push("busy");
      return states;
    };

    const speak = (el: Element) => ({
      name: accName(el),
      role: roleOf(el),
      states: statesOf(el),
      description: accDescription(el),
      live: el.getAttribute("aria-live") ?? "off",
    });

    const items = () => Array.from(document.querySelectorAll(selector)).filter(visible);

    let index = -1;
    w.__vo = {
      /** Swipe right: next element; swipe left: previous. Returns utterance. */
      swipe(direction: 1 | -1) {
        const list = items();
        if (!list.length) return null;
        index = index < 0 ? (direction === 1 ? 0 : list.length - 1) : index + direction;
        index = Math.max(0, Math.min(list.length - 1, index));
        const el = list[index]!;
        (el as HTMLElement).focus?.();
        return speak(el);
      },
      /** Re-reads whatever the VO cursor is currently on. */
      reread() {
        const list = items();
        const el = list[index];
        return el ? speak(el) : null;
      },
      /** Double-tap activates the element under the VO cursor. */
      doubleTap() {
        const list = items();
        const el = list[index] as HTMLElement | undefined;
        if (!el) return false;
        el.click();
        return true;
      },
      /** Live-region output VoiceOver would interrupt/queue, in order. */
      announcements: [] as { politeness: string; text: string }[],
    };

    const announce = (region: Element) => {
      const parts = [region.getAttribute("aria-label") ?? textOf(region)];
      region.querySelectorAll("[aria-label]").forEach((n) => parts.push(n.getAttribute("aria-label") ?? ""));
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      const politeness = region.getAttribute("aria-live") ?? "off";
      const log = (w.__vo as { announcements: { politeness: string; text: string }[] }).announcements;
      const last = log[log.length - 1];
      if (!text || (last && last.text === text && last.politeness === politeness)) return;
      log.push({ politeness, text });
    };

    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const region = target?.closest("[aria-live]");
        if (region) announce(region);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-live", "aria-disabled", "aria-busy", "disabled"],
    });
  }, VO_QUERY);
}

const swipe = (page: Page, direction: 1 | -1 = 1) =>
  page.evaluate(
    (d) => (window as unknown as { __vo: { swipe(d: 1 | -1): Utterance | null } }).__vo.swipe(d),
    direction,
  );

const reread = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vo: { reread(): Utterance | null } }).__vo.reread());

const doubleTap = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vo: { doubleTap(): boolean } }).__vo.doubleTap());

const announcements = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __vo: { announcements: { politeness: string; text: string }[] } }).__vo
        .announcements,
  );

/** Picks a phase and (optionally) forces the tooltip open in the lab harness. */
async function setup(page: Page, phase: string, opts: { tooltip?: boolean; light?: boolean } = {}) {
  await page.getByTestId(`lab-phase-${phase}`).click();
  if (opts.tooltip) await page.getByTestId("lab-tooltip-toggle").click();
  if (opts.light) await page.getByTestId("lab-theme-toggle").click();
  await expect(page.getByTestId("lab-stage")).toHaveAttribute("data-phase", phase);
  await expect(page.getByTestId("lab-stage")).toHaveAttribute(
    "data-tooltip",
    opts.tooltip ? "open" : "closed",
  );
}

test.describe("VoiceOver (iOS) — sync badge tooltip announcement", () => {
  for (const tooltip of [false, true]) {
    test(`swiping to the resolved badge speaks name, role and tooltip description (tooltip ${
      tooltip ? "open" : "closed"
    })`, async ({ page }) => {
      await openLab(page);
      await setup(page, "resolved", { tooltip });
      await installVoiceOver(page);

      const heard = await swipe(page);
      expect(heard).not.toBeNull();
      expect(heard!.role).toBe("status");
      expect(heard!.name).toMatch(/^Resolved\. Kept the most recent play position for 3 tracks\./);
      expect(heard!.live).toBe("polite");

      // The description is the tooltip copy — it must be spoken whether or not
      // the visual tooltip is on screen, because TooltipContent is aria-hidden.
      expect(heard!.description).toContain("Safari on iOS");
      expect(heard!.description.length).toBeGreaterThan(0);

      // Whenever the visual tooltip is on screen (forced open, or opened by the
      // VO cursor focusing the trigger) it must stay aria-hidden so the copy is
      // spoken once, via the description, and not duplicated.
      const visualTooltip = page.getByTestId("radio-sync-tooltip");
      for (let i = 0; i < (await visualTooltip.count()); i++) {
        await expect(visualTooltip.nth(i)).toHaveAttribute("aria-hidden", "true");
      }
    });
  }

  test("the resolving badge is spoken as busy", async ({ page }) => {
    await openLab(page);
    await setup(page, "resolving", { tooltip: true });
    await installVoiceOver(page);

    const heard = await swipe(page);
    expect(heard!.role).toBe("status");
    expect(heard!.states).toContain("busy");
    expect(heard!.name).toBe("Resolving playback timestamps across your devices.");
  });

  test("the failed badge is spoken as an assertive alert with its reason", async ({ page }) => {
    await openLab(page);
    await setup(page, "error", { tooltip: true });
    await installVoiceOver(page);

    const heard = await swipe(page);
    expect(heard!.role).toBe("alert");
    expect(heard!.live).toBe("assertive");
    expect(heard!.name).toBe(
      "Sync failed. Couldn't compare playback timestamps from your other devices.",
    );
    expect(heard!.description).toBe(
      "Sync failed. Couldn't compare playback timestamps from your other devices.",
    );
  });
});

test.describe("VoiceOver (iOS) — Retry button state changes", () => {
  test("swipe reaches Retry, double-tap flips it to Retrying, dimmed and busy", async ({ page }) => {
    await openLab(page);
    await setup(page, "error");
    await installVoiceOver(page);

    // Swipe 1: the alert chip. Swipe 2: the Retry button nested inside it.
    await swipe(page);
    const retry = await swipe(page);
    expect(retry).toMatchObject({ role: "button", name: "Retry timestamp sync" });
    expect(retry!.states).toEqual([]);
    // Focusing Retry reads the failure reason, so the action has context.
    expect(retry!.description).toContain("Couldn't compare playback timestamps");

    expect(await doubleTap(page)).toBe(true);
    await expect(page.getByTestId("lab-retry-count")).toHaveText("Retry fired 1");

    const after = await reread(page);
    expect(after!.name).toBe("Retrying timestamp sync");
    expect(after!.states).toEqual(expect.arrayContaining(["dimmed", "busy"]));

    // The state change is spoken through the assertive alert region.
    const spoken = await announcements(page);
    expect(spoken.some((a) => a.politeness === "assertive" && /Retrying timestamp sync/.test(a.text))).toBe(
      true,
    );

    // No stale "Retry timestamp sync" affordance is left for a VO user to hit.
    await expect(
      page.getByTestId("lab-badge").getByRole("button", { name: "Retry timestamp sync", exact: true }),
    ).toHaveCount(0);
  });

  test("a real double-tap gesture on the Retry button fires the retry", async ({ page }) => {
    await openLab(page);
    await setup(page, "error");

    // VoiceOver's double-tap dispatches the activation at the element itself.
    await page.getByTestId("radio-sync-retry").dispatchEvent("click");
    await expect(page.getByTestId("lab-retry-count")).toHaveText("Retry fired 1");
    await expect(
      page.getByTestId("lab-badge").getByRole("button", { name: "Retrying timestamp sync" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  test("the already-retrying badge speaks Retrying and swiping back re-reads the alert", async ({
    page,
  }) => {
    await openLab(page);
    await setup(page, "error-retrying", { light: true });
    await installVoiceOver(page);

    await swipe(page);
    const retry = await swipe(page);
    expect(retry!.name).toBe("Retrying timestamp sync");
    expect(retry!.states).toEqual(expect.arrayContaining(["dimmed", "busy"]));

    // Double-tapping a dimmed control must be inert.
    await doubleTap(page);
    await expect(page.getByTestId("lab-retry-count")).toHaveText("Retry fired 0");

    const back = await swipe(page, -1);
    expect(back!.role).toBe("alert");
    expect(back!.name).toBe(
      "Sync failed. Couldn't compare playback timestamps from your other devices.",
    );
  });
});
