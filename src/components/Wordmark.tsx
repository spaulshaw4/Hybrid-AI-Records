import { BRAND_EAGLE_PUBLIC } from "@/components/BrandEagle";
import usaEmblem from "@/assets/divisions/usa.png";

type WordmarkSize = "sm" | "md";

/** Classic black-backed USA crest (same asset as catalog / footer). */
const MARK_SRCSET = `${usaEmblem} 512w`;

const MARK_SIZE: Record<WordmarkSize, { cls: string; px: number; src: string; sizes: string }> = {
  sm: {
    cls: "division-emblem h-8 w-8 sm:h-10 sm:w-10",
    px: 40,
    src: usaEmblem,
    sizes: "(min-width: 640px) 40px, 32px",
  },
  md: {
    cls: "division-emblem h-10 w-10 sm:h-11 sm:w-11",
    px: 44,
    src: usaEmblem,
    sizes: "(min-width: 640px) 44px, 40px",
  },
};

export const WORDMARK_PRELOAD_LINK = {
  rel: "preload",
  as: "image",
  href: MARK_SIZE.sm.src,
  imageSrcSet: MARK_SRCSET,
  imageSizes: MARK_SIZE.sm.sizes,
  fetchPriority: "high",
} as const;

const TEXT_SIZE: Record<WordmarkSize, string> = {
  sm: "text-sm sm:text-lg md:text-xl",
  md: "text-sm sm:text-lg md:text-xl",
};

/**
 * Canonical Hybrid AI Records lockup: eagle mark + HYBRID AI RECORDS lettering.
 */
export function Wordmark({
  size = "md",
  showText = true,
  showMark = true,
  textClassName = "",
  className = "",
  interactive = false,
}: {
  size?: WordmarkSize;
  showText?: boolean;
  showMark?: boolean;
  textClassName?: string;
  className?: string;
  interactive?: boolean;
}) {
  const mark = MARK_SIZE[size];
  const markMotion = interactive
    ? " transition-transform duration-200 ease-out group-hover:scale-[1.06] group-active:scale-95 motion-reduce:transition-none motion-reduce:group-hover:scale-100 motion-reduce:group-active:scale-100"
    : "";
  const textMotion = interactive
    ? " transition-[filter,opacity] duration-200 ease-out group-hover:brightness-125 group-active:brightness-90 group-active:opacity-90 motion-reduce:transition-none"
    : "";

  return (
    <span className={`flex min-w-0 items-center gap-2 sm:gap-2.5 ${className}`}>
      {showMark && (
        <img
          src={mark.src}
          srcSet={MARK_SRCSET}
          sizes={mark.sizes}
          alt={showText ? "" : "Hybrid AI Records"}
          aria-hidden={showText || undefined}
          width={96}
          height={96}
          loading="eager"
          decoding="async"
          draggable={false}
          className={`${mark.cls} shrink-0 select-none bg-transparent object-contain [image-rendering:auto]${markMotion}`}
        />
      )}
      {showText && (
        <span
          dir="ltr"
          className={`whitespace-nowrap font-display ${TEXT_SIZE[size]} font-bold leading-none tracking-[0.04em]${textMotion} ${textClassName}`}
        >
          <span className="wordmark-pop-red text-wordmark-red drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">HYBRID</span>{" "}
          <span className="text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">AI</span>{" "}
          <span className="wordmark-pop-blue wordmark-records">RECORDS</span>
        </span>
      )}
    </span>
  );
}

export const WORDMARK_SOURCE_URL: string = BRAND_EAGLE_PUBLIC;

export const WORDMARK_LINK =
  "group inline-flex min-w-0 max-w-full items-center rounded-sm outline-none transition-opacity duration-200 hover:opacity-100 active:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none";

export default Wordmark;
