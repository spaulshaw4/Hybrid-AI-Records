import { useId } from "react";
import { crestAriaLabel, crestFor, resolveDivision, type Division, type DivisionSubject } from "@/lib/divisions";
import { useDivisionNames } from "@/lib/division-settings";

/** Intrinsic edge of the square emblem masters in src/assets/divisions. */
export const CREST_SOURCE_PX = 512;

export type CrestSize = "sm" | "md" | "lg";

const COPY: Record<Division, { org: string; division: string }> = {
  usa: { org: "HYBRID AI RECORDS", division: "USA DIVISION" },
  lithuania: { org: "HYBRID AI RECORDS", division: "LITHUANIA DIVISION" },
  nigeria: { org: "HYBRID AI RECORDS", division: "NIGERIA DIVISION" },
  jester: { org: "THE JESTER AI", division: "LEGACY RECORDS" },
};

const DIVISION_LABEL_CLASS: Record<Division, string> = {
  usa: "division-label division-label-usa",
  jester: "division-label division-label-jester",
  lithuania: "division-label division-label-lithuania",
  nigeria: "division-label division-label-nigeria",
};

const SIZE_CLASS: Record<CrestSize, string> = {
  sm: "max-w-[4.5rem]",
  md: "max-w-[6rem]",
  lg: "max-w-[7.5rem]",
};

/** Unframed square emblem — dark field blends into the page, no circular shield. */
export function DivisionCrest({
  release,
  size = "md",
  className = "",
  priority = false,
}: {
  release: DivisionSubject;
  size?: CrestSize;
  className?: string;
  /** Set on crests rendered above the fold so they load eagerly, not lazily. */
  priority?: boolean;
}) {
  const names = useDivisionNames();
  const crest = crestFor(release, names);
  const division = resolveDivision(release);
  const copy = COPY[division];
  const tooltipId = `crest-tooltip-${useId()}`;

  return (
    <div
      className={`flex min-w-0 flex-col items-center gap-2 ${className}`}
      data-testid="division-crest"
      data-crest-size={size}
    >
      <div
        className={`group/crest relative w-full ${SIZE_CLASS[size]} shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
        tabIndex={0}
        role="img"
        aria-label={crestAriaLabel(release, names)}
        aria-describedby={tooltipId}
      >
        <img
          src={crest.src}
          srcSet={crest.srcSet}
          sizes="96px"
          alt=""
          aria-hidden="true"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          draggable={false}
          width={512}
          height={512}
          className="division-emblem h-auto w-full select-none bg-transparent object-contain [image-rendering:-webkit-optimize-contrast]"
        />
        <span
          id={tooltipId}
          role="tooltip"
          data-testid="division-tooltip"
          className="pointer-events-none absolute end-0 top-[calc(100%+0.375rem)] z-20 hidden w-max max-w-[12rem] translate-y-1 whitespace-normal break-words rounded-sm border border-border-strong bg-background/95 px-2 py-1 text-end font-mono text-[9px] uppercase leading-snug tracking-[0.14em] text-foreground opacity-0 shadow-lg backdrop-blur-sm transition-all duration-300 ease-out group-hover/crest:translate-y-0 group-hover/crest:opacity-100 group-focus-within/crest:translate-y-0 group-focus-within/crest:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none sm:block"
        >
          {crest.label}
        </span>
      </div>
      <div
        aria-hidden="true"
        data-testid="division-label-mobile"
        className="text-center font-mono uppercase tracking-widest"
      >
        <span className="block text-xs text-slate-500">{copy.org}</span>
        <span className={`block text-sm font-bold ${DIVISION_LABEL_CLASS[division]}`}>{copy.division}</span>
      </div>
    </div>
  );
}
