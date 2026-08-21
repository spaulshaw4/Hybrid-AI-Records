import { useEffect, useRef, useState } from "react";

/**
 * localStorage-backed state that is SSR/hydration safe.
 * Starts from `initial`, then hydrates from storage after mount.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const hydrated = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore corrupt/unavailable storage */
    }
    hydrated.current = true;
  }, [key]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota/unavailable storage */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

export const STUDIO_KEYS = {
  genres: "hybrid.studio.genres",
  vocalGender: "hybrid.studio.vocalGender",
  vocalStyle: "hybrid.studio.vocalStyle",
  onlyEnglish: "hybrid.studio.onlyEnglish",
  promptBookGenre: "hybrid.studio.promptBookGenre",
} as const;
