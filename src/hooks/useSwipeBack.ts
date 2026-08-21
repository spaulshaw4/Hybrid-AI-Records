import * as React from "react";

const EDGE_ZONE_PX = 36;
const TRIGGER_PX = 84;
const MAX_DRAG_PX = 160;

/**
 * Edge swipe-to-go-back for touch devices.
 *
 * Listens for a touch that starts within the left edge zone and tracks
 * horizontal movement. Returns a 0..1 progress value so callers can render a
 * live affordance, and fires `onBack()` once the gesture passes the trigger
 * distance and the finger lifts.
 */
export function useSwipeBack(onBack: () => void, enabled = true) {
  const [progress, setProgress] = React.useState(0);
  const onBackRef = React.useRef(onBack);
  onBackRef.current = onBack;

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let horizontal = false;
    let distance = 0;

    const reset = () => {
      tracking = false;
      horizontal = false;
      distance = 0;
      setProgress(0);
    };

    const handleStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch.clientX > EDGE_ZONE_PX) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      horizontal = false;
      distance = 0;
    };

    const handleMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!horizontal) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
          reset();
          return;
        }
        if (dx > 12) horizontal = true;
        else return;
      }

      distance = Math.max(0, Math.min(dx, MAX_DRAG_PX));
      setProgress(distance / TRIGGER_PX > 1 ? 1 : distance / TRIGGER_PX);
    };

    const handleEnd = () => {
      if (!tracking) return;
      const shouldNavigate = horizontal && distance >= TRIGGER_PX;
      reset();
      if (shouldNavigate) onBackRef.current();
    };

    window.addEventListener("touchstart", handleStart, { passive: true });
    window.addEventListener("touchmove", handleMove, { passive: true });
    window.addEventListener("touchend", handleEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });

    return () => {
      window.removeEventListener("touchstart", handleStart);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, [enabled]);

  return progress;
}
