/**
 * Lightweight, dependency-free breadcrumb trail (Sentry-style) recorded in the
 * browser and attached to every crash report. Exists because iOS Safari kills
 * the tab without a JS error on memory pressure / render-tree blowups, so the
 * *sequence* of events before the white screen is the only usable signal.
 *
 * Everything here is best-effort and must never throw: a broken breadcrumb
 * recorder would take down the very screens we are trying to diagnose.
 */

export type Breadcrumb = {
  /** ms since page load, so we can see gaps/stalls before a freeze. */
  t: number;
  category: string;
  message: string;
  data?: Record<string, string | number | boolean>;
};

const MAX_BREADCRUMBS = 30;
const MAX_MESSAGE = 160;

const trail: Breadcrumb[] = [];
const start = typeof performance !== "undefined" ? performance.now() : 0;

function now(): number {
  return typeof performance !== "undefined" ? Math.round(performance.now() - start) : 0;
}

export function addBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, string | number | boolean>,
): void {
  try {
    trail.push({ t: now(), category, message: String(message).slice(0, MAX_MESSAGE), data });
    if (trail.length > MAX_BREADCRUMBS) trail.splice(0, trail.length - MAX_BREADCRUMBS);
  } catch {
    /* never throw from instrumentation */
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  return trail.slice();
}

/** Compact one-line-per-crumb rendering so logs stay readable and small. */
export function formatBreadcrumbs(): string | undefined {
  if (trail.length === 0) return undefined;
  return trail
    .map((c) => {
      const extra = c.data
        ? " " +
          Object.entries(c.data)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      return `+${c.t}ms [${c.category}] ${c.message}${extra}`;
    })
    .join("\n")
    .slice(0, 4_000);
}

/**
 * Device/runtime fingerprint. iOS-specific fields (standalone PWA, visual
 * viewport vs layout viewport, safe-area insets) are what distinguish an
 * address-bar-resize crash from an ordinary render error.
 */
export function deviceContext(): Record<string, string | number | boolean> {
  if (typeof window === "undefined") return {};
  const ua = navigator.userAgent;
  const nav = navigator as Navigator & { standalone?: boolean; deviceMemory?: number };
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const vv = window.visualViewport;

  const ctx: Record<string, string | number | boolean> = {
    platform: isIOS ? "ios" : /Android/.test(ua) ? "android" : "other",
    isIOS,
    isSafari: /^((?!chrome|android|crios|fxios).)*safari/i.test(ua),
    standalone:
      nav.standalone === true ||
      (typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: Math.round(window.devicePixelRatio * 100) / 100,
    orientation: window.innerWidth > window.innerHeight ? "landscape" : "portrait",
    online: navigator.onLine,
  };
  if (vv) {
    ctx.visualW = Math.round(vv.width);
    ctx.visualH = Math.round(vv.height);
    // A large gap means the URL/toolbar chrome is currently overlapping —
    // the classic trigger for 100vh layout blowups on iOS Safari.
    ctx.chromeGap = Math.round(window.innerHeight - vv.height);
  }
  if (typeof nav.deviceMemory === "number") ctx.deviceMemory = nav.deviceMemory;
  return ctx;
}
