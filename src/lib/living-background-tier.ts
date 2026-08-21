/**
 * Device-capability tier for the ambient crest background.
 *
 * iOS Safari does not expose `navigator.deviceMemory`, and recent iPhones
 * report 6+ cores, so a "unknown → full" default would keep the expensive
 * drift+filter rotation running on the devices that overheat first.
 */

export type LivingBackgroundTier = "full" | "lite" | "static";

export type LivingBackgroundSignals = {
  safeMode?: boolean;
  reducedMotion?: boolean;
  saveData?: boolean;
  effectiveType?: string;
  deviceMemory?: number;
  cores?: number;
  coarse?: boolean;
  innerWidth?: number;
  isIOS?: boolean;
};

/** iPadOS 13+ reports as Macintosh; touch points distinguish a real Mac. */
export function isIosUserAgent(ua: string, maxTouchPoints = 0): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && maxTouchPoints > 1);
}

/**
 * Classify a device from cheap, already-available signals.
 *
 * Anything unknown is treated as capable only after we have ruled out iOS,
 * coarse pointers, and small viewports.
 */
export function detectLivingBackgroundTier(signals: LivingBackgroundSignals = {}): LivingBackgroundTier {
  if (signals.safeMode) return "static";

  const slowNetwork = signals.effectiveType === "slow-2g" || signals.effectiveType === "2g";
  if (signals.reducedMotion || signals.saveData || slowNetwork) return "static";

  const small = typeof signals.innerWidth === "number" && signals.innerWidth < 768;
  if (signals.isIOS || signals.coarse || small) return "lite";

  if (
    (typeof signals.deviceMemory === "number" && signals.deviceMemory <= 4) ||
    (typeof signals.cores === "number" && signals.cores <= 4)
  ) {
    return "lite";
  }
  if (signals.effectiveType === "3g") return "lite";

  return "full";
}

/** Read live window/navigator signals. Safe to call only in the browser. */
export function detectLivingBackgroundTierFromWindow(): LivingBackgroundTier {
  if (typeof window === "undefined") return "static";

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; saveData?: boolean };
  };
  const ua = navigator.userAgent;

  return detectLivingBackgroundTier({
    safeMode: false,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType,
    deviceMemory: nav.deviceMemory,
    cores: navigator.hardwareConcurrency,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    innerWidth: window.innerWidth,
    isIOS: isIosUserAgent(ua, navigator.maxTouchPoints),
  });
}
