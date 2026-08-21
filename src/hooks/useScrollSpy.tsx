import { useEffect, useState } from "react";

/**
 * Tracks which of the given section ids is currently the "active" one in the
 * viewport, accounting for the fixed 4rem header. Returns the active id, or
 * null before hydration / when nothing matches.
 */
export function useScrollSpy(ids: string[], offset = 96): string | null {
  const key = ids.join(",");
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const sectionIds = key.split(",").filter(Boolean);
    if (sectionIds.length === 0) return;

    let frame = 0;

    const compute = () => {
      frame = 0;
      const line = offset + 1;
      let current: string | null = null;

      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= line && rect.bottom > line) current = id;
      }

      // Past the end of the page, keep the last visible section lit.
      if (!current) {
        const atBottom =
          window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;
        if (atBottom) {
          for (const id of sectionIds) {
            if (document.getElementById(id)) current = id;
          }
        }
      }

      setActive(current);
    };

    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [key, offset]);

  return active;
}
