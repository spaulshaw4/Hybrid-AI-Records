import type React from "react";
import jesterEmblem from "@/assets/divisions/jester.png";
import usaEmblem from "@/assets/divisions/usa.png";
import lithuaniaEmblem from "@/assets/divisions/lithuania.png";
import nigeriaEmblem from "@/assets/divisions/nigeria.png";
import { DEFAULT_DIVISION_NAMES, type DivisionNames } from "@/lib/division-settings";

export type Division = "jester" | "lithuania" | "nigeria" | "usa";

export type CrestFit = "cover" | "contain";

export type Crest = {
  src: string;
  srcSet: string;
  alt: string;
  label: string;
  width: number;
  height: number;
  fit: CrestFit;
};

const CREST_MASTERS: Record<Division, string> = {
  jester: jesterEmblem,
  lithuania: lithuaniaEmblem,
  nigeria: nigeriaEmblem,
  usa: usaEmblem,
};

const CREST_IMAGES: Record<Division, string> = CREST_MASTERS;

const CREST_INTRINSIC: Record<Division, { width: number; height: number; fit: CrestFit }> = {
  jester: { width: 512, height: 512, fit: "contain" },
  lithuania: { width: 512, height: 512, fit: "contain" },
  nigeria: { width: 512, height: 512, fit: "contain" },
  usa: { width: 512, height: 512, fit: "contain" },
};

/** Square emblem masters — one file per division, no circular lockup variants. */
export const CREST_WIDTHS = [512] as const;

export const crestSrcSet = (d: Division): string => `${CREST_IMAGES[d]} 512w`;

/**
 * Head preload descriptor for a crest rendered above the fold. It mirrors the
 * exact src/srcSet/sizes the badge uses, so the browser fetches one
 * device-correct variant with the document and the badge box is filled on
 * first paint instead of popping in later.
 */
export const crestPreloadLink = (
  d: Division,
  sizes = "192px",
): React.LinkHTMLAttributes<HTMLLinkElement> => ({
  rel: "preload",
  as: "image",
  href: CREST_IMAGES[d],
  imageSrcSet: crestSrcSet(d),
  imageSizes: sizes,
  fetchPriority: "high",
});

/** Builds crest branding (label + alt text) from the current division names. */
export function buildCrests(names: DivisionNames = DEFAULT_DIVISION_NAMES): Record<Division, Crest> {
  const make = (d: Division): Crest => ({
    src: CREST_IMAGES[d],
    srcSet: crestSrcSet(d),
    alt: `${names[d]} crest`,
    label: names[d],
    ...CREST_INTRINSIC[d],
  });
  return { jester: make("jester"), lithuania: make("lithuania"), nigeria: make("nigeria"), usa: make("usa") };
}

/** Full-resolution masters, for OG images, print and download use. */
export const CREST_SOURCE_URLS: Record<Division, string> = CREST_MASTERS;

/** Default branding — every consumer that renders should prefer useDivisionNames(). */
export const CRESTS = buildCrests();

export type DivisionSubject = { title: string; artist: string; division?: Division };

/** Resolves a release's division, inferring Jester AI credits when not set explicitly. */
export const resolveDivision = (r: DivisionSubject): Division => {
  if (r.division) return r.division;
  if (/the jester ai/i.test(r.artist) || /jester/i.test(r.title)) return "jester";
  return "usa";
};

export const crestFor = (r: DivisionSubject, names?: DivisionNames): Crest =>
  buildCrests(names)[resolveDivision(r)];

/**
 * Single announcement contract for every crest: the full division name (never
 * an abbreviation), then the release it marks. The name is spoken once — the
 * artwork itself stays decorative so nothing is repeated.
 */
export const crestAriaLabel = (r: DivisionSubject, names?: DivisionNames): string => {
  const crest = crestFor(r, names);
  return `${crest.alt}. ${r.title} by ${r.artist}.`;
};
