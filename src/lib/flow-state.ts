/**
 * Per-package /start flow state.
 *
 * Field values live in application-drafts (per single/bundle scope). This
 * module remembers *where in the flow* the artist was — which track type they
 * picked and how far the progress indicator had advanced — so a refresh or a
 * later visit lands them back on the same step with the same selection.
 */

export type FlowState = {
  /** "single" | "bundle" */
  mode: "single" | "bundle";
  /** Whether the track type step was completed. */
  typeConfirmed: boolean;
  /** Furthest zero-based step reached, used to restore the indicator. */
  step: number;
  savedAt: number;
};

const PREFIX = "hybrid.application.flow.v1";

const keyFor = (slug: string) => `${PREFIX}:${slug}`;

export const readFlowState = (slug: string): FlowState | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(slug));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<FlowState>;
    if (typeof d !== "object" || d === null) return null;
    return {
      mode: d.mode === "bundle" ? "bundle" : "single",
      typeConfirmed: Boolean(d.typeConfirmed),
      step: Number.isFinite(Number(d.step)) ? Math.max(0, Math.min(3, Number(d.step))) : 0,
      savedAt: Number(d.savedAt ?? 0),
    };
  } catch {
    return null;
  }
};

export const writeFlowState = (slug: string, state: Omit<FlowState, "savedAt">) => {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      keyFor(slug),
      JSON.stringify({ ...state, savedAt: Date.now() } satisfies FlowState),
    );
    return true;
  } catch {
    return false;
  }
};

export const clearFlowState = (slug: string) => {
  try {
    window.localStorage.removeItem(keyFor(slug));
  } catch {
    /* storage unavailable — nothing to clear */
  }
};
