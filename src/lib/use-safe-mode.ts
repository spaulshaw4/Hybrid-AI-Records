import { useEffect, useState } from "react";
import {
  getSafeModeState,
  initSafeMode,
  subscribeSafeMode,
  type SafeModeState,
} from "./webkit-safe-mode";

/**
 * Reactive view of WebKit Safe Mode. Always reports `false` during SSR and the
 * first client render so hydration matches; the real value lands in an effect.
 */
export function useSafeMode(): SafeModeState {
  const [state, setState] = useState<SafeModeState>(() => ({
    active: false,
    auto: false,
    incidents: 0,
  }));

  useEffect(() => {
    setState(initSafeMode());
    setState(getSafeModeState());
    return subscribeSafeMode(setState);
  }, []);

  return state;
}
