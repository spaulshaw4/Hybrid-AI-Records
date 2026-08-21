import { useEffect, useState } from "react";
import { isIosUserAgent } from "./living-background-tier";

/**
 * Crimson text-glow strength, exposed to CSS as the `--glow-strength`
 * multiplier that scales every glow layer in styles.css.
 */

const STORAGE_KEY = "hybrid:glow-strength-v2";
/** Bloom off by default — neon text-glow is the main eye-strain source. */
export const DEFAULT_GLOW_STRENGTH = 0;
export const MIN_GLOW_STRENGTH = 0;
export const MAX_GLOW_STRENGTH = 2;
/** First-visit default on iPhone — keep bloom off for comfort and GPU cost. */
export const IOS_DEFAULT_GLOW_STRENGTH = 0;

const listeners = new Set<(value: number) => void>();
let current = DEFAULT_GLOW_STRENGTH;

function clamp(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_GLOW_STRENGTH;
  return Math.min(MAX_GLOW_STRENGTH, Math.max(MIN_GLOW_STRENGTH, value));
}

function paint(value: number) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--glow-strength", String(value));
}

export function readGlowStrength(): number {
  if (typeof window === "undefined") return DEFAULT_GLOW_STRENGTH;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return isIosUserAgent(navigator.userAgent, navigator.maxTouchPoints)
        ? IOS_DEFAULT_GLOW_STRENGTH
        : DEFAULT_GLOW_STRENGTH;
    }
    return clamp(Number.parseFloat(raw));
  } catch {
    return DEFAULT_GLOW_STRENGTH;
  }
}

export function setGlowStrength(value: number) {
  current = clamp(value);
  paint(current);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    /* private mode: keep the in-memory value */
  }
  listeners.forEach((listener) => listener(current));
}

export function resetGlowStrength() {
  setGlowStrength(DEFAULT_GLOW_STRENGTH);
}

/** Applies the stored value once the client has hydrated. */
export function useGlowStrength() {
  const [value, setValue] = useState(current);

  useEffect(() => {
    current = readGlowStrength();
    paint(current);
    setValue(current);
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  return value;
}
