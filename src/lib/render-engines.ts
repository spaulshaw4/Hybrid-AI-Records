/**
 * Internal render-engine ids. The composer never offers a picker — every
 * generate runs the timed pipeline in the background.
 */
export const RENDER_ENGINES = [
  { value: "minimax" },
  { value: "hybrid" },
  { value: "elevenlabs" },
] as const;

export type RenderEngine = (typeof RENDER_ENGINES)[number]["value"];

export const DEFAULT_RENDER_ENGINE: RenderEngine = "hybrid";

export const RENDER_ENGINE_KEY = "hybrid.studio.engine";

export function isRenderEngine(value: unknown): value is RenderEngine {
  return RENDER_ENGINES.some((e) => e.value === value);
}

export function renderEngineLabel(value: RenderEngine): string {
  return value;
}

export function readSavedEngine(): RenderEngine {
  if (typeof window === "undefined") return DEFAULT_RENDER_ENGINE;
  try {
    const raw = window.localStorage.getItem(RENDER_ENGINE_KEY);
    return isRenderEngine(raw) ? raw : DEFAULT_RENDER_ENGINE;
  } catch {
    return DEFAULT_RENDER_ENGINE;
  }
}

export function saveEngine(value: RenderEngine) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RENDER_ENGINE_KEY, value);
  } catch {
    /* private mode — preference simply does not persist */
  }
}
