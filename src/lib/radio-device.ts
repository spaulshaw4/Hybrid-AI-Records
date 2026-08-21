/**
 * Stable per-device identity used to explain cross-device timestamp conflicts.
 * The label is human-readable ("Chrome on macOS") so the sync badge tooltip can
 * name which device's play/seek action won for a track.
 */

const DEVICE_KEY = "hybrid-radio-device";

export const LOCAL_DEVICE_FALLBACK = "This device";

function detectLabel(): string {
  if (typeof navigator === "undefined") return "This device";
  const ua = navigator.userAgent || "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "Web";
  return `${browser} on ${os}`;
}

/** This device's label, generated once and kept in local storage. */
export function deviceLabel(): string {
  if (typeof window === "undefined") return "This device";
  try {
    const saved = window.localStorage.getItem(DEVICE_KEY);
    if (saved) return saved;
    const label = detectLabel();
    window.localStorage.setItem(DEVICE_KEY, label);
    return label;
  } catch {
    return detectLabel();
  }
}
