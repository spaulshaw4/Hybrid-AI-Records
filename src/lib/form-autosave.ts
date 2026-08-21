import { useEffect, useRef, useState } from "react";

/**
 * Draft autosave for in-progress forms.
 *
 * Values are written to localStorage (debounced) so a refresh, a back
 * navigation, or an accidental tab close never loses what was typed or
 * selected. SSR-safe: the first render always uses `initial`, and the stored
 * draft is applied after mount to avoid hydration mismatches.
 */

const PREFIX = "hybrid.draft.";
/** Drafts older than this are treated as stale and ignored. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

type Stored<T> = { v: T; t: number };

export function readDraft<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored<T>;
    if (!parsed || typeof parsed.t !== "number") return null;
    if (Date.now() - parsed.t > MAX_AGE_MS) {
      window.localStorage.removeItem(PREFIX + key);
      return null;
    }
    return parsed.v;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ v: value, t: Date.now() }));
  } catch {
    /* storage full or blocked — the form still works, it just won't persist */
  }
}

export function clearDraft(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/**
 * `useState` that restores and autosaves its value under `key`.
 * Pass `enabled: false` to keep a field out of the saved draft.
 */
export function useAutosavedState<T>(
  key: string,
  initial: T,
  options: { enabled?: boolean; delay?: number } = {},
) {
  const { enabled = true, delay = 400 } = options;
  const [value, setValue] = useState<T>(initial);
  const restored = useRef(false);

  // Restore after mount so server and client render the same first pass.
  useEffect(() => {
    if (!enabled) {
      restored.current = true;
      return;
    }
    const saved = readDraft<T>(key);
    if (saved !== null && saved !== undefined) setValue(saved);
    restored.current = true;
    // Re-restore when the draft key changes (e.g. a different package).
  }, [key, enabled]);

  // Debounced save — avoids a storage write on every keystroke.
  useEffect(() => {
    if (!enabled || !restored.current) return;
    const id = setTimeout(() => writeDraft(key, value), delay);
    return () => clearTimeout(id);
  }, [key, value, enabled, delay]);

  return [value, setValue, () => clearDraft(key)] as const;
}
