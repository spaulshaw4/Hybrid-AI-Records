/**
 * iOS white-screen detector.
 *
 * A React render-tree failure on iOS Safari frequently produces *no* error at
 * all: the boundary never mounts, the tab just paints white. We therefore
 * sample the DOM shortly after hydration (and after every route change) and
 * report when the app root is visually empty, with the breadcrumb trail that
 * led there. Also records the freeze/resume signals Safari fires right before
 * it discards a tab, so a crash that kills the page still leaves a trace.
 */

import { addBreadcrumb, deviceContext } from "./client-breadcrumbs";
import { reportClientError } from "./client-error-report";
import { recordRenderIncident } from "./webkit-safe-mode";

/** Time after paint before we consider an empty root a real white screen. */
const SETTLE_MS = 2_500;
/** Below this many rendered px² of content, the screen is effectively blank. */
const MIN_PAINTED_AREA = 1_000;

/** Repeat blank screens are the Safe Mode signal, so we cool down instead of
 *  reporting only once per page life. */
const REPORT_COOLDOWN_MS = 15_000;

let installed = false;
let lastReportAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function rootEl(): HTMLElement | null {
  return (document.querySelector("main") as HTMLElement | null) ?? document.body;
}

/** Heuristic: does the page currently show anything a human could read? */
function paintedArea(): number {
  const root = rootEl();
  if (!root) return 0;
  const rect = root.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return 0;
  const text = (root.innerText ?? "").trim();
  const visuals = root.querySelectorAll("img, svg, canvas, video, input, button");
  if (text.length === 0 && visuals.length === 0) return 0;
  return rect.width * rect.height;
}

function check(reason: string): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") return;
  if (Date.now() - lastReportAt < REPORT_COOLDOWN_MS) return;
  const area = paintedArea();
  if (area >= MIN_PAINTED_AREA) return;

  lastReportAt = Date.now();
  reportClientError(new Error(`Blank screen detected after ${reason}`), {
    source: "white-screen-watchdog",
    extra: {
      reason,
      paintedArea: area,
      bodyChildren: document.body?.childElementCount ?? 0,
      readyState: document.readyState,
      ...deviceContext(),
    },
  });
  // Repeated blank screens on this device engage WebKit Safe Mode.
  recordRenderIncident("white-screen");
}

/** Re-arms the watchdog; call after hydration and on every route change. */
export function armWhiteScreenWatch(reason: string): void {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => check(reason), SETTLE_MS);
}

/** Installs page-lifecycle instrumentation once, from a client effect. */
export function installWhiteScreenWatch(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;

  addBreadcrumb("lifecycle", "hydrated", deviceContext());
  armWhiteScreenWatch("hydration");

  document.addEventListener("visibilitychange", () => {
    addBreadcrumb("lifecycle", `visibility:${document.visibilityState}`);
    if (document.visibilityState === "visible") armWhiteScreenWatch("tab-resume");
  });

  // Safari fires freeze/resume (and pagehide with persisted=true) when it
  // suspends or discards a backgrounded tab — the usual "app crashed" report.
  window.addEventListener("pagehide", (event) => {
    addBreadcrumb("lifecycle", "pagehide", { persisted: event.persisted });
  });
  window.addEventListener("freeze", () => addBreadcrumb("lifecycle", "freeze"));
  window.addEventListener("resume", () => {
    addBreadcrumb("lifecycle", "resume");
    armWhiteScreenWatch("tab-resume");
  });

  // Address-bar show/hide resizes the visual viewport; correlating this with a
  // blank screen is what proves a dvh/vh layout regression.
  window.visualViewport?.addEventListener("resize", () => {
    const vv = window.visualViewport;
    if (!vv) return;
    addBreadcrumb("viewport", "visual-resize", {
      h: Math.round(vv.height),
      innerH: window.innerHeight,
      gap: Math.round(window.innerHeight - vv.height),
    });
  });

  window.addEventListener("orientationchange", () => {
    addBreadcrumb("viewport", "orientationchange");
    armWhiteScreenWatch("orientationchange");
  });

  // iOS kills tabs under memory pressure; a low-memory hint right before a
  // blank screen distinguishes OOM from a render bug.
  window.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement | null;
    const label =
      target?.closest("button,a,[role=button]")?.textContent?.trim().slice(0, 48) ??
      target?.tagName ??
      "unknown";
    addBreadcrumb("ui", `tap:${label}`);
  });
}
