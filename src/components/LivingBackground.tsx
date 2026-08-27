import { useEffect, useState } from "react";
import { crestUrl, type CrestName } from "@/lib/crest-sources";
import { isSafeModeActive, subscribeSafeMode } from "@/lib/webkit-safe-mode";
import {
  detectLivingBackgroundTierFromWindow,
  type LivingBackgroundTier,
} from "@/lib/living-background-tier";
import usaCrest from "@/assets/hybrid-ai-records-eagle.jpg";
import lithuaniaCrest from "@/assets/hybrid-ai-records-lithuania.jpg";
import nigeriaCrest from "@/assets/hybrid-ai-records-nigeria.jpg";
import jesterCrest from "@/assets/hybrid-ai-records-jester.jpg";
import usaEmblem from "@/assets/divisions/usa.png";
import jesterEmblem from "@/assets/divisions/jester.png";
import lithuaniaEmblem from "@/assets/divisions/lithuania.png";
import nigeriaEmblem from "@/assets/divisions/nigeria.png";

type Tier = LivingBackgroundTier;

/** Cycle order: Hybrid AI → Jester → Lithuania → Nigeria. */
export const DIVISION_WATERMARKS: Array<{ name: CrestName; src: string; label: string }> = [
  { name: "usa", src: crestUrl("usa", 1024), label: "Hybrid AI Records" },
  { name: "jester", src: crestUrl("jester", 1024), label: "The Jester AI" },
  { name: "lithuania", src: crestUrl("lithuania", 1024), label: "Lithuania" },
  { name: "nigeria", src: crestUrl("nigeria", 1024), label: "Nigeria" },
];

/** Footer emblems: original black-backed division masters + classic labels. */
export const DIVISION_FOOTER_CRESTS = [
  {
    name: "usa" as const,
    src: usaEmblem,
    label: "Hybrid AI Records",
    title: "USA DIVISION",
  },
  {
    name: "jester" as const,
    src: jesterEmblem,
    label: "The Jester AI",
    title: "LEGACY RECORDS",
  },
  {
    name: "lithuania" as const,
    src: lithuaniaEmblem,
    label: "Lithuania",
    title: "LITHUANIA DIVISION",
  },
  {
    name: "nigeria" as const,
    src: nigeriaEmblem,
    label: "Nigeria",
    title: "NIGERIA DIVISION",
  },
];

/** Kept for callers that still import the old tile map. */
export const DIVISION_LOGO_TILES = {
  usa: usaCrest,
  lithuania: lithuaniaCrest,
  nigeria: nigeriaCrest,
  jester: jesterCrest,
} as const;

const ROTATE_MS: Record<Tier, number> = {
  full: 8000,
  lite: 10000,
  static: 14000,
};

/** Peak watermark alpha — high enough to read as a hero mark, low enough for copy. */
const WATERMARK_OPACITY: Record<Tier, number> = {
  full: 0.42,
  lite: 0.34,
  static: 0.3,
};

function detectTier(): Tier {
  if (typeof window === "undefined") return "static";
  if (isSafeModeActive()) return "static";
  return detectLivingBackgroundTierFromWindow();
}

/**
 * Cinematic dark canvas: fluid red/black glow plus one watermark crest
 * that cross-fades through the four divisions. Logos are not tiled.
 */
export function LivingBackground() {
  const [tier, setTier] = useState<Tier>("full");
  const [hidden, setHidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    setTier(detectTier());
    return subscribeSafeMode((state) => {
      if (state.active) setTier("static");
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    let loaded = 0;
    let cancelled = false;

    for (const crest of DIVISION_WATERMARKS) {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        loaded += 1;
        if (!cancelled && loaded >= 1) setReady(true);
      };
      img.src = crest.src;
    }

    const timeout = window.setTimeout(() => {
      if (!cancelled) setReady(true);
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (reduceMotion || hidden) return;
    const tick = () => {
      if (document.documentElement.getAttribute("data-overlay-open") === "true") return;
      if (document.visibilityState === "hidden") return;
      setActive((index) => (index + 1) % DIVISION_WATERMARKS.length);
    };
    const id = window.setInterval(tick, ROTATE_MS[tier]);
    return () => window.clearInterval(id);
  }, [tier, hidden, reduceMotion]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.classList.add("app-bg");
    body.classList.add("app-bg");
    return () => {
      html.classList.remove("app-bg");
      body.classList.remove("app-bg");
    };
  }, []);

  const peak = WATERMARK_OPACITY[tier];

  return (
    <div
      aria-hidden="true"
      data-ready={ready ? "true" : "false"}
      data-fallback="false"
      data-tier={tier}
      data-paused={hidden ? "true" : "false"}
      data-active={DIVISION_WATERMARKS[active]?.name}
      data-testid="logo-wallpaper"
      className="living-bg flowing-patriotic-bg app-bg pointer-events-none fixed inset-0 z-0 min-h-dvh select-none overflow-hidden"
      style={{ pointerEvents: "none" }}
    >
      <div className="living-bg-cinematic pointer-events-none absolute inset-0" />
      <div className="living-bg-glow pointer-events-none absolute inset-0" />
      <div className="living-bg-matrix pointer-events-none absolute inset-0" />

      {DIVISION_WATERMARKS.map((crest, index) => (
        <div
          key={crest.name}
          className={`living-bg-layer living-bg-watermark pointer-events-none absolute inset-0${index === active ? " is-active" : ""}`}
          style={{
            backgroundImage: `url("${crest.src}")`,
            opacity: index === active && ready ? peak : 0,
          }}
        />
      ))}

      <div className="living-bg-veil pointer-events-none absolute inset-0" />
    </div>
  );
}

const DIVISION_TITLE_CLASS = {
  usa: "text-red-500",
  jester: "text-blue-400",
  lithuania: "text-emerald-400",
  nigeria: "text-green-500",
} as const;

/** Four division crests — original artwork + Official Label captions. */
export function DivisionFooterBadge({ className = "" }: { className?: string }) {
  return (
    <div
      className={`mt-12 w-full border-t border-white/10 bg-black/40 py-8 ${className}`}
      role="group"
      aria-label="Hybrid AI Records divisions"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-8 px-4 text-center">
        {DIVISION_FOOTER_CRESTS.map((crest) => (
          <figure key={crest.name} className="m-0 flex min-w-[140px] flex-col items-center gap-1">
            <img
              src={crest.src}
              alt={`${crest.title} emblem`}
              title={crest.label}
              width={512}
              height={512}
              className="division-emblem mb-1 h-auto w-full max-w-[6.5rem] select-none bg-transparent object-contain [image-rendering:-webkit-optimize-contrast]"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
            <figcaption className="flex flex-col items-center gap-1">
              <span className="text-[10px] uppercase tracking-widest text-gray-400">Official Label</span>
              <span className={`text-xs font-black tracking-wider ${DIVISION_TITLE_CLASS[crest.name]}`}>
                {crest.title}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

export default LivingBackground;
