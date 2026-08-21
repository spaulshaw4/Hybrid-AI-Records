/**
 * Runtime detection for "why can't I add this to my Home Screen?" on iOS.
 *
 * Everything here is heuristic — iOS exposes no install API — but the four
 * signals below cover the real-world causes: wrong OS, wrong browser, an
 * in-app webview, Private Browsing, or an app that is already installed.
 */

export type IosBrowser = "safari" | "in-app" | "other-browser" | "not-ios";

export type DiagnosticStatus = "ok" | "warn" | "blocked" | "unknown";

export type Diagnostic = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
};

export type IosInstallReport = {
  browser: IosBrowser;
  isIos: boolean;
  standalone: boolean;
  privateBrowsing: boolean | null;
  canInstall: boolean;
  diagnostics: Diagnostic[];
};

const IN_APP_RE = /FBAN|FBAV|Instagram|Line|Twitter|TikTok|Snapchat|Pinterest|LinkedInApp|MicroMessenger|GSA/i;
const ALT_BROWSER_RE = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Brave/i;

export function detectIosBrowser(ua: string, maxTouchPoints: number): {
  isIos: boolean;
  browser: IosBrowser;
} {
  // iPadOS 13+ reports a Mac UA, so touch points disambiguate the tablet.
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (!isIos) return { isIos: false, browser: "not-ios" };
  if (IN_APP_RE.test(ua)) return { isIos, browser: "in-app" };
  if (ALT_BROWSER_RE.test(ua)) return { isIos, browser: "other-browser" };
  return { isIos, browser: "safari" };
}

/**
 * Private Browsing in Safari still exposes localStorage, but the storage
 * estimate quota collapses to a few MB. `null` means we couldn't tell.
 */
export async function detectPrivateBrowsing(): Promise<boolean | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate || typeof estimate.quota !== "number") return null;
    return estimate.quota < 120_000_000;
  } catch {
    return null;
  }
}

export function buildDiagnostics(input: {
  isIos: boolean;
  browser: IosBrowser;
  standalone: boolean;
  privateBrowsing: boolean | null;
  secure: boolean;
}): Diagnostic[] {
  const { isIos, browser, standalone, privateBrowsing, secure } = input;
  const list: Diagnostic[] = [];

  list.push({
    id: "device",
    label: "Device",
    status: isIos ? "ok" : "warn",
    detail: isIos
      ? "iPhone or iPad detected."
      : "This isn't an iPhone or iPad — these steps are for iOS only.",
  });

  list.push({
    id: "browser",
    label: "Browser",
    status: browser === "safari" ? "ok" : browser === "not-ios" ? "unknown" : "blocked",
    detail:
      browser === "safari"
        ? "Safari — Add to Home Screen is available here."
        : browser === "in-app"
          ? "You're in an app's built-in browser. Tap ••• → Open in Safari."
          : browser === "other-browser"
            ? "Apple only allows Safari to add apps. Reopen this page in Safari."
            : "Not applicable outside iOS.",
  });

  list.push({
    id: "private",
    label: "Private Browsing",
    status: privateBrowsing === true ? "blocked" : privateBrowsing === false ? "ok" : "unknown",
    detail:
      privateBrowsing === true
        ? "Looks like a private tab — Safari hides Add to Home Screen there. Switch to a normal tab."
        : privateBrowsing === false
          ? "Normal tab — nothing hiding the Share action."
          : "Couldn't tell. If the option is missing, switch out of a private tab.",
  });

  list.push({
    id: "secure",
    label: "Secure connection",
    status: secure ? "ok" : "blocked",
    detail: secure
      ? "Served over HTTPS."
      : "Not a secure connection — iOS won't offer an app install.",
  });

  list.push({
    id: "installed",
    label: "Install state",
    status: standalone ? "ok" : "warn",
    detail: standalone
      ? "Already running as an installed app."
      : "Running in the browser — not installed yet.",
  });

  return list;
}

export async function runIosInstallDiagnostics(): Promise<IosInstallReport> {
  const ua = navigator.userAgent;
  const { isIos, browser } = detectIosBrowser(ua, navigator.maxTouchPoints ?? 0);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const privateBrowsing = await detectPrivateBrowsing();
  const secure = window.isSecureContext;
  const diagnostics = buildDiagnostics({ isIos, browser, standalone, privateBrowsing, secure });

  return {
    browser,
    isIos,
    standalone,
    privateBrowsing,
    canInstall: isIos && browser === "safari" && secure && privateBrowsing !== true && !standalone,
    diagnostics,
  };
}
