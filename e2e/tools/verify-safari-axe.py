"""Replay e2e/sync-badge-axe.mobile.spec.ts on the sandbox's iOS/WebKit build.

The image's WebKit predates this repo's @playwright/test protocol, so
`bunx playwright test --project=mobile-safari` cannot launch it. Python's
Playwright ships a matching WebKit, so this script runs the same axe-core audit
and the same ARIA-contract assertions on the iPhone 13 profile and prints a
pass/fail line per case.

Run with the dev server up:  python3 e2e/tools/verify-safari-axe.py
"""

import asyncio
import json
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = "http://localhost:8080"
HARNESS = f"{BASE}/dev/sync-badge"
AXE = Path("/dev-server/node_modules/axe-core/axe.min.js")
THEMES = ("dark", "light")
PHASES = ("synced", "resolving", "resolved", "conflict", "error", "error-retrying")

SCAN_JS = """async (sel) => {
  const results = await window.axe.run(sel, { resultTypes: ['violations'] });
  return results.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help,
    nodes: v.nodes.map(n => n.html) }));
}"""

DESCRIBE_JS = """(sel) => {
  const chip = document.querySelector(sel + ' [data-testid="radio-sync-status"]');
  if (!chip) return null;
  const ids = (chip.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
  return {
    role: chip.getAttribute('role'),
    name: chip.getAttribute('aria-label') || '',
    live: chip.getAttribute('aria-live'),
    expanded: chip.getAttribute('aria-expanded'),
    describedby: ids,
    descriptions: ids.map(id => (document.getElementById(id)?.textContent || '').trim() || null),
  };
}"""

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(f"{name}: {detail}")


async def open_harness(page):
    await page.clock.set_fixed_time("2026-01-15T12:00:00Z")
    await page.goto(HARNESS, wait_until="networkidle")
    await page.get_by_role("heading", name="Sync badge states").wait_for()
    await page.evaluate("document.fonts.ready")
    await page.add_script_tag(path=str(AXE))


async def audit(page, theme, phase):
    sel = f'[data-testid="badge-{theme}-{phase}"]'
    badge = page.locator(sel)
    await badge.scroll_into_view_if_needed()

    resting = await page.evaluate(SCAN_JS, sel)
    check(f"{theme}/{phase} resting badge: zero axe violations", resting == [], json.dumps(resting)[:400])

    chip = await page.evaluate(DESCRIBE_JS, sel)
    check(f"{theme}/{phase} chip exists", chip is not None)
    if not chip:
        return
    check(f"{theme}/{phase} chip role is status|alert", chip["role"] in ("status", "alert"), str(chip["role"]))
    check(f"{theme}/{phase} chip has an accessible name", len(chip["name"]) > 0, chip["name"])
    # ARIA APG: a tooltip trigger must not expose aria-expanded.
    check(f"{theme}/{phase} chip has no aria-expanded", chip["expanded"] is None, str(chip["expanded"]))
    check(f"{theme}/{phase} chip is described by at least one node", len(chip["describedby"]) > 0)
    check(
        f"{theme}/{phase} every aria-describedby id resolves to text",
        all(bool(d) for d in chip["descriptions"]),
        str(list(zip(chip["describedby"], chip["descriptions"]))),
    )

    await badge.get_by_test_id("radio-sync-status").focus()
    popper = page.locator("[data-radix-popper-content-wrapper]:visible")
    opened = True
    try:
        await popper.first.wait_for(state="visible", timeout=3000)
    except Exception:
        opened = False
    check(f"{theme}/{phase} tooltip opens on focus", opened)

    tip_violations = await page.evaluate(SCAN_JS, "[data-radix-popper-content-wrapper]")
    check(
        f"{theme}/{phase} open tooltip: zero axe violations",
        tip_violations == [],
        json.dumps(tip_violations)[:400],
    )

    tooltip = page.get_by_test_id("radio-sync-tooltip").first
    hidden = await tooltip.get_attribute("aria-hidden")
    check(f"{theme}/{phase} tooltip stays out of the a11y tree", hidden == "true", str(hidden))
    text = (await tooltip.inner_text()).strip()
    check(f"{theme}/{phase} tooltip still shows visible copy", len(text) > 0, text[:60])

    after = await page.evaluate(DESCRIBE_JS, sel)
    check(f"{theme}/{phase} chip ARIA unchanged by opening the tooltip", after == chip, str(after))


async def audit_retry(page, theme):
    sel = f'[data-testid="badge-{theme}-error"]'
    badge = page.locator(sel)
    await badge.scroll_into_view_if_needed()
    retry = badge.get_by_test_id("radio-sync-retry")
    await retry.focus()

    focused = await page.evaluate(SCAN_JS, sel)
    check(f"{theme}/retry focused: zero axe violations", focused == [], json.dumps(focused)[:400])

    info = await retry.evaluate(
        "el => ({ name: (el.getAttribute('aria-label') || el.textContent || '').trim(),"
        " describedby: el.getAttribute('aria-describedby'),"
        " ariaDisabled: el.getAttribute('aria-disabled'),"
        " disabled: el.hasAttribute('disabled') })"
    )
    check(f"{theme}/retry has an accessible name", len(info["name"]) > 0, str(info))
    check(f"{theme}/retry has a description", bool(info["describedby"]), str(info))
    check(f"{theme}/retry uses aria-disabled, not disabled", info["disabled"] is False, str(info))

    await page.keyboard.press("Enter")
    await page.get_by_test_id(f"retry-count-{theme}-error").wait_for(state="visible", timeout=3000)
    retrying = await page.evaluate(SCAN_JS, sel)
    check(f"{theme}/retry mid-retry: zero axe violations", retrying == [], json.dumps(retrying)[:400])


async def main():
    async with async_playwright() as pw:
        browser = await pw.webkit.launch(headless=True)
        for theme in THEMES:
            for phase in PHASES:
                context = await browser.new_context(**pw.devices["iPhone 13"], timezone_id="UTC")
                page = await context.new_page()
                try:
                    await open_harness(page)
                    await audit(page, theme, phase)
                except Exception as exc:
                    check(f"{theme}/{phase}", False, repr(exc))
                await context.close()

            context = await browser.new_context(**pw.devices["iPhone 13"], timezone_id="UTC")
            page = await context.new_page()
            try:
                await open_harness(page)
                await audit_retry(page, theme)
            except Exception as exc:
                check(f"{theme}/retry", False, repr(exc))
            await context.close()
        await browser.close()

    print("\n" + ("ALL PASS" if not failures else f"{len(failures)} FAILURE(S)"))
    for f in failures:
        print("  -", f)
    sys.exit(1 if failures else 0)


asyncio.run(main())
