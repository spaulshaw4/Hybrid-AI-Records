import { useEffect, useState } from "react";

/**
 * Glow *saturation* preset — how deep the red and how strong the blue read —
 * kept separate from `--glow-strength`, which controls how far the bloom
 * spreads. The preset is written to `data-glow-intensity` on <html>; styles.css
 * swaps the `--glow-red` / `--glow-white` / `--glow-blue` palette accordingly.
 *
 * Accessibility: this is a colour-only setting. It never enables motion, and
 * the reduced-motion media queries in styles.css keep every glow animation
 * disabled at all three levels — a reduced-motion visitor still gets the
 * chosen saturation as a static bloom.
 */
export type GlowIntensity = "low" | "default" | "high";

const STORAGE_KEY = "hybrid:glow-intensity";
export const DEFAULT_GLOW_INTENSITY: GlowIntensity = "default";

export const GLOW_INTENSITIES: ReadonlyArray<{
  value: GlowIntensity;
  label: string;
  hint: string;
}> = [
  { value: "low", label: "Low", hint: "Warm crimson and steel — easiest to read." },
  { value: "default", label: "Default", hint: "Soft tri-colour, no neon bloom." },
  { value: "high", label: "High", hint: "Deeper crimson and steel — still muted." },
];

const listeners = new Set<(value: GlowIntensity) => void>();
let current: GlowIntensity = DEFAULT_GLOW_INTENSITY;

function normalize(value: string | null): GlowIntensity {
  return value === "low" || value === "high" || value === "default"
    ? value
    : DEFAULT_GLOW_INTENSITY;
}

function paint(value: GlowIntensity) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["glowIntensity"] = value;
}

export function readGlowIntensity(): GlowIntensity {
  if (typeof window === "undefined") return DEFAULT_GLOW_INTENSITY;
  try {
    return normalize(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_GLOW_INTENSITY;
  }
}

export function setGlowIntensity(value: GlowIntensity) {
  current = normalize(value);
  paint(current);
  try {
    window.localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* private mode: keep the in-memory value */
  }
  listeners.forEach((listener) => listener(current));
}

export function resetGlowIntensity() {
  setGlowIntensity(DEFAULT_GLOW_INTENSITY);
}

/** Applies the stored preset once the client has hydrated. */
export function useGlowIntensity(): GlowIntensity {
  const [value, setValue] = useState(current);

  useEffect(() => {
    current = readGlowIntensity();
    paint(current);
    setValue(current);
    listeners.add(setValue);
    return () => {
      listeners.delete(setValue);
    };
  }, []);

  return value;
}
