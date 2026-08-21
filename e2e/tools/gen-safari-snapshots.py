"""Generate the iOS Safari (WebKit) baselines for e2e/sync-badge-visual.mobile.spec.ts.

The sandbox ships a WebKit build whose protocol predates the repo's
@playwright/test, so `--update-snapshots --project=mobile-safari` can't drive
it directly. This script replays the exact same steps as the spec (same device
profile, widths, themes, fixed clock, screenshot options) using the runnable
WebKit and writes the PNGs under the spec's snapshot folder with Playwright's
`-mobile-safari-linux` suffix, so CI compares against real WebKit pixels.
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path("/dev-server/e2e/sync-badge-visual.mobile.spec.ts-snapshots")
BASE = "http://localhost:8080"
HARNESS = f"{BASE}/dev/sync-badge"
WIDTHS = (320, 360, 390, 430)
THEMES = ("dark", "light")
SUFFIX = "mobile-safari-linux"

# Resting success/idle phases — must match RESTING in the spec.
RESTING = ("synced", "synced-aligned", "resolved", "conflict")


def out(name: str) -> str:
    return str(OUT / f"{name}-{SUFFIX}.png")


async def open_harness(page, width, pinned_tooltip=None):
    await page.set_viewport_size({"width": width, "height": 900})
    await page.clock.set_fixed_time("2026-01-15T12:00:00Z")
    url = f"{HARNESS}?tooltip={pinned_tooltip}" if pinned_tooltip else HARNESS
    await page.goto(url, wait_until="networkidle")
    await page.get_by_role("heading", name="Sync badge states").wait_for()
    await page.evaluate("document.fonts.ready")


async def shot(locator, name):
    await locator.screenshot(path=out(name), animations="disabled")


async def run(page, width, theme):
    badge = lambda phase: page.get_by_test_id(f"badge-{theme}-{phase}")

    # 1. Tooltip, pinned open from the harness (same as the spec).
    await open_harness(page, width, f"{theme}:resolved")
    trigger = badge("resolved").get_by_test_id("radio-sync-status")
    await trigger.evaluate(
        "el => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 200, behavior: 'instant' })"
    )
    tooltip = page.locator("[data-radix-popper-content-wrapper]").first
    await tooltip.wait_for(state="visible")
    box = await tooltip.bounding_box()
    assert box["x"] >= 0 and box["x"] + box["width"] <= width + 1, (width, theme, box)
    await page.screenshot(
        path=out(f"sync-badge-m{width}-tooltip-{theme}"),
        animations="disabled",
        clip={
            "x": max(0, int(box["x"]) - 4),
            "y": max(0, int(box["y"]) - 4),
            "width": int(box["width"]) + 8,
            "height": int(box["height"]) + 8,
        },
    )

    # 2. Focus rings on the status chip and on Retry.
    await open_harness(page, width)
    synced = badge("synced-aligned")
    await synced.scroll_into_view_if_needed()
    await synced.get_by_test_id("radio-sync-status").focus()
    await shot(synced, f"sync-badge-m{width}-focus-status-{theme}")

    failed = badge("error")
    await failed.scroll_into_view_if_needed()
    await failed.get_by_test_id("radio-sync-retry").focus()
    await shot(failed, f"sync-badge-m{width}-focus-retry-{theme}")

    # 3. Resting success/idle chips: no focus ring, no tooltip.
    for phase in RESTING:
        chip = badge(phase)
        await chip.scroll_into_view_if_needed()
        await page.evaluate("() => document.activeElement && document.activeElement.blur()")
        await chip.get_by_test_id("radio-sync-status").wait_for(state="visible")
        await shot(chip, f"sync-badge-m{width}-resting-{phase}-{theme}")


async def run_reduced(page, width, theme):
    badge = lambda phase: page.get_by_test_id(f"badge-{theme}-{phase}")
    await open_harness(page, width)

    resolving = badge("resolving")
    await resolving.scroll_into_view_if_needed()
    await resolving.get_by_test_id("radio-sync-static-progress").wait_for(state="visible")
    await shot(resolving, f"sync-badge-m{width}-reduced-resolving-{theme}")

    retrying = badge("error-retrying")
    await retrying.scroll_into_view_if_needed()
    await retrying.get_by_test_id("radio-sync-retry-static").wait_for(state="visible")
    await shot(retrying, f"sync-badge-m{width}-reduced-retry-{theme}")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        browser = await pw.webkit.launch(headless=True)
        iphone = pw.devices["iPhone 13"]
        for reduced in (False, True):
            context = await browser.new_context(
                **{**iphone, "timezone_id": "UTC"},
                reduced_motion="reduce" if reduced else "no-preference",
            )
            page = await context.new_page()
            for width in WIDTHS:
                for theme in THEMES:
                    if reduced:
                        await run_reduced(page, width, theme)
                    else:
                        await run(page, width, theme)
                    print("done", "reduced" if reduced else "normal", width, theme, flush=True)
            await context.close()
        await browser.close()


asyncio.run(main())
