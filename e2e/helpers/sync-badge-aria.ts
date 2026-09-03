import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared ARIA assertions for the sync badge and its tooltip.
 *
 * Used by the visual suites (so a pixel-perfect badge can still fail when its
 * semantics regress) and by the behavioural E2E suites. Everything here is
 * asserted the way an assistive technology reads it: role, accessible name,
 * and the state attributes Radix flips when the tooltip opens.
 */

export type BadgeAria = {
  /** "status" for the healthy phases, "alert" for the failure phase. */
  role: "status" | "alert";
  /** Expected computed accessible name of the chip. */
  name?: string | RegExp;
  /** Whether the tooltip is currently open for this badge. */
  tooltipOpen?: boolean;
  /** Whether the badge is mid-flight (aria-busy). */
  busy?: boolean;
};

/**
 * Asserts the chip's role, accessible name, live-region wiring and tooltip
 * trigger state.
 *
 * Note on `aria-expanded`: a tooltip is *not* a disclosure or a popup widget,
 * so ARIA APG forbids `aria-expanded` on its trigger — the trigger is described
 * by the tooltip, not expanded by it. We assert its absence deliberately, and
 * assert Radix's `data-state` instead as the open/closed signal.
 */
export async function expectBadgeAria(scope: Locator, aria: BadgeAria) {
  const chip = scope.getByTestId("radio-sync-status");
  await expect(chip).toBeVisible();

  await expect(chip).toHaveAttribute("role", aria.role);
  await expect(chip).toHaveAttribute("aria-live", aria.role === "alert" ? "assertive" : "polite");
  await expect(chip).toHaveAttribute("aria-atomic", "true");

  if (aria.name !== undefined) await expect(chip).toHaveAccessibleName(aria.name);

  // The chip is reachable and describable: keyboard-focusable trigger with a
  // description node that actually exists in the DOM.
  await expect(chip).toHaveAttribute("tabindex", "0");
  const describedBy = await chip.getAttribute("aria-describedby");
  expect(describedBy, "chip must be described by its tooltip text node").toBeTruthy();
  await expect(scope.locator(`[id="${describedBy}"]`)).toHaveCount(1);

  // Tooltip triggers must never advertise aria-expanded (see note above).
  await expect(chip).not.toHaveAttribute("aria-expanded", /.*/);

  if (aria.tooltipOpen !== undefined) {
    // Error badges put Radix's trigger on the presentational cluster so Retry
    // can sit beside the chip without nested-interactive. Healthy phases keep
    // data-state on the chip itself.
    const cluster = scope.getByTestId("radio-sync-error-cluster");
    const trigger = (await cluster.count()) > 0 ? cluster : chip;
    await expect(trigger).toHaveAttribute("data-state", aria.tooltipOpen ? /open$/ : "closed");
  }

  if (aria.busy) await expect(chip).toHaveAttribute("aria-busy", "true");
  else await expect(chip).not.toHaveAttribute("aria-busy", /.*/);
}

/** Asserts the Retry control's role, accessible name and busy/disabled state. */
export async function expectRetryAria(scope: Locator, opts: { retrying?: boolean } = {}) {
  const retry = scope.getByRole("button", {
    name: opts.retrying ? "Retrying timestamp sync" : "Retry timestamp sync",
  });
  await expect(retry).toBeVisible();
  await expect(retry).toHaveAccessibleName(
    opts.retrying ? "Retrying timestamp sync" : "Retry timestamp sync",
  );
  // aria-disabled (not `disabled`) keeps focus on the button across phase churn.
  if (opts.retrying) {
    await expect(retry).toHaveAttribute("aria-disabled", "true");
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toHaveAttribute("aria-live", "assertive");
    await expect(retry).not.toHaveAttribute("disabled", /.*/);
  } else {
    await expect(retry).not.toHaveAttribute("aria-disabled", /.*/);
    await expect(retry).not.toHaveAttribute("aria-live", /.*/);
  }
  await expect(retry).toHaveAttribute("aria-describedby", /.+/);
}

/**
 * Asserts the rendered tooltip popper: Radix gives it role="tooltip", and we
 * mark the visual copy aria-hidden so the chip's own description is the single
 * announced source (no duplicate speech).
 */
export async function expectTooltipAria(page: Page, text?: string | RegExp) {
  const popper = page.locator("[data-radix-popper-content-wrapper]").first();
  await expect(popper).toBeVisible({ timeout: 3000 });

  // Radix keeps a single visually-hidden copy with role="tooltip" for the a11y
  // tree; the painted content is aria-hidden so nothing is announced twice.
  await expect(page.locator('[role="tooltip"]')).toHaveCount(1);

  const content = page.getByTestId("radio-sync-tooltip").first();
  await expect(content).toHaveAttribute("aria-hidden", "true");
  await expect(content).toHaveAttribute("data-state", /open$/);
  if (text !== undefined) await expect(content).toContainText(text);
}

/**
 * Vite compiles the harness route on first hit. Queries fired against the
 * SSR shell race React hydration and swallow the first hover/Tab. Wait for
 * the root marker — it flips true only after effects attach listeners.
 */
export async function waitForHarnessHydrated(page: Page) {
  const marker = '[data-testid="sync-badge-harness"][data-hydrated="true"]';
  try {
    await page.waitForSelector(marker, { state: "attached", timeout: 30_000 });
  } catch {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(marker, { state: "attached", timeout: 30_000 });
  }
  await expect(page.getByRole("heading", { name: "Sync badge states" })).toBeVisible({
    timeout: 30_000,
  });
}
