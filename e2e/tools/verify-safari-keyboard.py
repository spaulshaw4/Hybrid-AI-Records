"""Replay e2e/sync-badge-keyboard.mobile.spec.ts on the sandbox's iOS/WebKit build.

The image ships a WebKit whose remote protocol predates this repo's
@playwright/test, so `bunx playwright test --project=mobile-safari` cannot
launch it (it dies on `Page.overrideSetting`). Python's Playwright ships a
matching WebKit, so this script drives the same steps, on the same iPhone 13
profile, and prints a pass/fail line per case.

Run with the dev server up:  python3 e2e/tools/verify-safari-keyboard.py
"""

import asyncio
import sys

from playwright.async_api import async_playwright

BASE = "http://localhost:8080"
HARNESS = f"{BASE}/dev/sync-badge"

ACTIVE_JS = """() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { testid: null, tag: 'body', badge: null };
  return {
    testid: el.getAttribute('data-testid'),
    tag: el.tagName.toLowerCase(),
    badge: el.closest("[data-testid^='badge-']")?.getAttribute('data-testid') ?? null,
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


async def active(page):
    return await page.evaluate(ACTIVE_JS)


def popper(page):
    return page.locator("[data-radix-popper-content-wrapper]:visible").last


async def popper_visible(page) -> bool:
    try:
        await popper(page).wait_for(state="visible", timeout=2500)
        return True
    except Exception:
        return False


async def popper_hidden(page) -> bool:
    try:
        await page.locator("[data-radix-popper-content-wrapper]:visible").first.wait_for(
            state="hidden", timeout=2500
        )
        return True
    except Exception:
        return await page.locator("[data-radix-popper-content-wrapper]:visible").count() == 0


async def tab_to(page, testid, key="Tab", max_presses=40):
    for i in range(1, max_presses + 1):
        await page.keyboard.press(key)
        if (await active(page))["testid"] == testid:
            return i
    raise AssertionError(f"never reached {testid} after {max_presses} {key} presses")


async def case_tab_opens(page):
    await open_harness(page)
    presses = await tab_to(page, "radio-sync-status")
    check("Tab reaches the status chip (<=3 presses)", presses <= 3, f"{presses} presses")
    check("focus opens the tooltip", await popper_visible(page))
    text = await popper(page).inner_text()
    check("tooltip text is the synced sentence", "Mix synced to" in text, text[:60])
    ring = await page.get_by_test_id("radio-sync-status").first.evaluate(
        "el => { const s = getComputedStyle(el);"
        " return { shadow: s.boxShadow, outline: s.outlineStyle + ' ' + s.outlineWidth }; }"
    )
    check(
        "focus ring is painted by WebKit",
        ring["shadow"] != "none" or ring["outline"] != "none 0px",
        str(ring),
    )


async def case_escape_keeps_focus(page):
    await open_harness(page)
    await tab_to(page, "radio-sync-status")
    await popper_visible(page)
    await page.keyboard.press("Escape")
    check("Escape closes the tooltip", await popper_hidden(page))
    a = await active(page)
    check(
        "Escape leaves focus on the chip",
        a == {"testid": "radio-sync-status", "tag": "span", "badge": "badge-dark-synced"},
        str(a),
    )


async def case_tab_after_escape(page):
    await open_harness(page)
    await tab_to(page, "radio-sync-status")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Tab")
    a = await active(page)
    check("Tab after Escape advances (no focus trap)", a["badge"] != "badge-dark-synced" and a["tag"] != "body", str(a))


async def case_shift_tab_roundtrip(page):
    await open_harness(page)
    await tab_to(page, "radio-sync-status")
    await page.keyboard.press("Shift+Tab")
    a = await active(page)
    check("Shift+Tab leaves the chip", a["testid"] != "radio-sync-status", str(a))
    check("tooltip closes on backwards focus loss", await popper_hidden(page))
    await page.keyboard.press("Tab")
    a = await active(page)
    check("Tab returns to the chip", a["testid"] == "radio-sync-status", str(a))
    check("tooltip re-opens on return", await popper_visible(page))


async def case_retry_tab_order(page):
    await open_harness(page)
    await page.get_by_test_id("badge-dark-error").scroll_into_view_if_needed()
    await tab_to(page, "radio-sync-retry")
    a = await active(page)
    check("Tab reaches Retry inside the failed badge", a["badge"] == "badge-dark-error", str(a))
    await page.keyboard.press("Shift+Tab")
    a = await active(page)
    check(
        "Shift+Tab from Retry lands on its own status chip",
        a["testid"] == "radio-sync-status" and a["badge"] == "badge-dark-error",
        str(a),
    )
    check("chip tooltip opens on the way back", await popper_visible(page))
    await page.keyboard.press("Tab")
    a = await active(page)
    check("Tab forwards returns to Retry", a["testid"] == "radio-sync-retry", str(a))


async def case_enter_retry(page):
    await open_harness(page)
    await page.get_by_test_id("badge-dark-error").scroll_into_view_if_needed()
    await tab_to(page, "radio-sync-retry")
    await page.keyboard.press("Enter")
    fired = True
    try:
        await page.get_by_test_id("retry-count-dark-error").wait_for(state="visible", timeout=3000)
    except Exception:
        fired = False
    check("Enter activates Retry", fired)
    a = await active(page)
    # aria-disabled (not `disabled`) is what keeps WebKit from blurring here.
    check("focus stays on Retry through the retrying swap", a["testid"] == "radio-sync-retry", str(a))


async def case_escape_from_retry(page):
    await open_harness(page)
    await page.get_by_test_id("badge-dark-error").scroll_into_view_if_needed()
    await tab_to(page, "radio-sync-retry")
    await page.keyboard.press("Escape")
    check("Escape from Retry closes the tooltip", await popper_hidden(page))
    a = await active(page)
    check("Escape from Retry keeps focus on Retry", a["testid"] == "radio-sync-retry", str(a))


CASES = (
    case_tab_opens,
    case_escape_keeps_focus,
    case_tab_after_escape,
    case_shift_tab_roundtrip,
    case_retry_tab_order,
    case_enter_retry,
    case_escape_from_retry,
)


async def main():
    async with async_playwright() as pw:
        browser = await pw.webkit.launch(headless=True)
        for case in CASES:
            print(f"\n--- {case.__name__} ---")
            context = await browser.new_context(**pw.devices["iPhone 13"], timezone_id="UTC")
            page = await context.new_page()
            try:
                await case(page)
            except Exception as exc:  # a thrown case is a failed case
                check(case.__name__, False, repr(exc))
            await context.close()
        await browser.close()

    print("\n" + ("ALL PASS" if not failures else f"{len(failures)} FAILURE(S)"))
    for f in failures:
        print("  -", f)
    sys.exit(1 if failures else 0)


asyncio.run(main())
