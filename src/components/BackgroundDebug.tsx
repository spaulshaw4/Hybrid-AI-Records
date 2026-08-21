import { useEffect, useState } from "react";

/**
 * Temporary diagnostic overlay for the LivingBackground.
 *
 * Toggle with Ctrl/Cmd + Shift + B, or by loading any page with ?bgdebug=1.
 * It samples the live computed styles of the background container, each
 * cross-fading layer and the darkening veil once per animation frame, so you
 * can confirm stacking order, opacity ramps and animation play state without
 * opening devtools. Purely read-only — it never mutates the background.
 */

type LayerInfo = {
  label: string;
  zIndex: string;
  opacity: string;
  animationName: string;
  playState: string;
  transform: string;
  visible: boolean;
  /** Position within the layer's own keyframe cycle, 0..1 (null when not animating). */
  progress: number | null;
  /** Human phase derived from the opacity ramp direction. */
  phase: string;
  /** Layer opacity after the container's own opacity and the veil scrim are applied. */
  effective: number | null;
};

/** Largest alpha found in a computed color/gradient string — approximates scrim strength. */
function maxAlpha(css: string): number {
  let max = 0;
  const re = /rgba?\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    const a = parts.length >= 4 ? Number(parts[3]) : 1;
    if (Number.isFinite(a)) max = Math.max(max, a);
  }
  return max;
}

/** Live cross-fade position for an element, read from the Web Animations API. */
function readProgress(el: Element): number | null {
  const anims = typeof el.getAnimations === "function" ? el.getAnimations() : [];
  for (const a of anims) {
    const timing = a.effect?.getComputedTiming?.();
    const duration = Number(timing?.duration ?? 0);
    const time = Number(a.currentTime ?? 0);
    if (duration > 0) {
      const iterationStart = Number(timing?.delay ?? 0);
      const elapsed = Math.max(0, time - iterationStart);
      return (elapsed % duration) / duration;
    }
  }
  return null;
}

function readInfo(
  el: Element,
  label: string,
  ctx?: { previousOpacity?: number; scrim: number; containerOpacity: number },
): LayerInfo {
  const s = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const t = s.transform;
  const opacity = Number(s.opacity);
  const progress = readProgress(el);
  let phase = "—";
  if (progress !== null && ctx?.previousOpacity !== undefined) {
    const delta = opacity - ctx.previousOpacity;
    if (opacity <= 0.005) phase = "hidden";
    else if (opacity >= 0.995) phase = "peak";
    else if (delta > 0.0005) phase = "fading in";
    else if (delta < -0.0005) phase = "fading out";
    else phase = "holding";
  }
  return {
    label,
    zIndex: s.zIndex,
    opacity: opacity.toFixed(3),
    animationName: s.animationName === "none" ? "—" : s.animationName,
    playState: s.animationPlayState,
    transform: t === "none" ? "none" : t.replace(/matrix\(([^)]*)\)/, (_m, v) => `matrix(${v})`),
    visible: rect.width > 0 && rect.height > 0 && opacity > 0.001,
    progress,
    phase,
    effective: ctx ? opacity * ctx.containerOpacity * (1 - ctx.scrim) : null,
  };
}


export function BackgroundDebug() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LayerInfo[]>([]);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [scrimAlpha, setScrimAlpha] = useState(0);


  // Query-string opt-in, evaluated after hydration so SSR output stays stable.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("bgdebug") === "1") setOpen(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);

    let frame = 0;
    const prevOpacity = new Map<string, number>();
    const tick = () => {
      const container = document.querySelector(".living-bg");
      const next: LayerInfo[] = [];
      let scrim = 0;
      if (container) {
        const veil = container.querySelector(".living-bg-veil");
        if (veil) {
          const vs = getComputedStyle(veil);
          scrim = Math.min(
            1,
            maxAlpha(`${vs.backgroundImage} ${vs.backgroundColor}`) * Number(vs.opacity || 1),
          );
        }
        const containerOpacity = Number(getComputedStyle(container).opacity);
        next.push(readInfo(container, "container .living-bg"));
        container.querySelectorAll(".living-bg-layer").forEach((el, i) => {
          const src = (el as HTMLElement).style.backgroundImage.match(/([^/]+)\.(jpg|png|webp)/i);
          const label = `layer ${i + 1} · ${src?.[1] ?? "?"}`;
          const info = readInfo(el, label, {
            previousOpacity: prevOpacity.get(label),
            scrim,
            containerOpacity,
          });
          prevOpacity.set(label, Number(info.opacity));
          next.push(info);
        });
        if (veil) next.push(readInfo(veil, "veil"));
      }
      const body = document.body;
      for (const pseudo of ["::before", "::after"] as const) {
        const s = getComputedStyle(body, pseudo);
        next.push({
          label: `body${pseudo}`,
          zIndex: s.zIndex,
          opacity: Number(s.opacity).toFixed(3),
          animationName: "—",
          playState: "—",
          transform: "—",
          visible: s.content !== "none",
          progress: null,
          phase: "—",
          effective: null,
        });
      }
      setScrimAlpha(scrim);

      setRows(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      mq.removeEventListener("change", onChange);
    };
  }, [open]);

  if (!open) return null;

  const missing = rows.length === 0;
  const container = document.querySelector(".living-bg");
  const assetState =
    container?.getAttribute("data-ready") === "true" ? "loaded" : "loading…";
  const fallbackActive = container?.getAttribute("data-fallback") === "true";


  return (
    <div
      role="status"
      aria-live="off"
      aria-label="Background debug overlay"
      className="fixed bottom-24 left-3 z-[9999] max-h-[60dvh] w-[min(22rem,calc(100vw-1.5rem))] overflow-auto rounded-lg border border-border/70 bg-background/95 p-3 font-mono text-[11px] leading-tight text-foreground shadow-xl backdrop-blur"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold tracking-wide">Background debug</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
        >
          close
        </button>
      </div>

      <p className="mb-2 text-muted-foreground">
        assets: {assetState} · fallback:{" "}
        <span className={fallbackActive ? "text-destructive" : undefined}>
          {fallbackActive ? "active (static crest)" : "off"}
        </span>{" "}
        · reduced motion: {reducedMotion ? "on (frozen)" : "off"} · toggle: Ctrl/Cmd+Shift+B
      </p>

      <p className="mb-2 text-muted-foreground">
        scrim (veil) alpha: {scrimAlpha.toFixed(3)} · effective = layer × container × (1 − scrim)
      </p>


      {missing ? (
        <p className="text-destructive">No .living-bg element found in the DOM.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="border-t border-border/50 pt-1.5 first:border-0 first:pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className={r.visible ? "text-primary" : "text-muted-foreground"}>
                  {r.visible ? "visible" : "hidden"}
                </span>
              </div>
              <div className="text-muted-foreground">
                z:{r.zIndex} · opacity:{r.opacity}
                {r.effective !== null ? ` · effective:${r.effective.toFixed(3)}` : ""}
              </div>
              {r.progress !== null && (
                <>
                  <div className="text-muted-foreground">
                    cross-fade: {(r.progress * 100).toFixed(1)}% · {r.phase}
                  </div>
                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded bg-muted">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${Math.min(100, r.progress * 100)}%` }}
                    />
                  </div>
                </>
              )}
              <div className="truncate text-muted-foreground">
                anim:{r.animationName} ({r.playState})
              </div>
              <div className="truncate text-muted-foreground">{r.transform}</div>

            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default BackgroundDebug;
