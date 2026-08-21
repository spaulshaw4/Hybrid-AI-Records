/**
 * iOS Safari overlay compositing guard.
 *
 * Mobile WebKit keeps a limited pool of accelerated layers. The living
 * background rotates four full-screen crests with `will-change: opacity,
 * transform`, and the hero light washes add two more blurred composited
 * layers. When Radix opens a portalled overlay (style select, prompt sheet,
 * modal) WebKit has to promote yet another layer while scroll is locked — on
 * older iPhones the compositor drops the whole tree and the page freezes as a
 * black screen until you rotate the device.
 *
 * The guard flags `<html data-overlay-open="true">` while any Radix overlay is
 * open, which the stylesheet uses to park the background animations and drop
 * their `will-change` hints, freeing those layers for the overlay. On close it
 * schedules a repaint nudge on the next animation frame (never a synchronous
 * layout read in a loop), so WebKit re-rasterises the page instead of leaving
 * a stale black tile behind.
 */

const OPEN_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  "[data-radix-select-content]",
  "[data-radix-menu-content]",
  '[role="dialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
  '[data-state="open"][data-slot="sheet-content"]',
].join(",");

let installed = false;

/** Repaints the document root without blocking the main thread. */
function nudgeRepaint() {
  const root = document.documentElement;
  requestAnimationFrame(() => {
    root.style.setProperty("--repaint-nudge", "1");
    requestAnimationFrame(() => {
      root.style.removeProperty("--repaint-nudge");
    });
  });
}

/**
 * Starts watching for open Radix overlays. Safe to call more than once and on
 * the server (no-op). Returns a teardown for tests.
 */
export function installOverlayCompositingGuard(): () => void {
  if (typeof document === "undefined" || installed) return () => {};
  installed = true;

  const root = document.documentElement;
  let open = false;

  const sync = () => {
    let next = false;
    try {
      next = document.querySelector(OPEN_SELECTOR) !== null;
    } catch {
      next = false;
    }
    if (next === open) return;
    open = next;
    if (next) root.setAttribute("data-overlay-open", "true");
    else root.removeAttribute("data-overlay-open");
    // Both directions matter: promoting and demoting layers is exactly when
    // WebKit leaves the stale tile behind.
    nudgeRepaint();
  };

  let scheduled = false;
  const requestSync = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  };

  const observer = new MutationObserver(() => requestSync());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // `style` is too noisy (radio progress, glow vars) and is not how Radix
    // signals an open overlay — `data-state` / `aria-hidden` are.
    attributeFilter: ["data-state", "aria-hidden"],
  });

  sync();

  return () => {
    observer.disconnect();
    root.removeAttribute("data-overlay-open");
    installed = false;
  };
}
