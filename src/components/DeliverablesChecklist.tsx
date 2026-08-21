import { Check, Minus, Music, Video, Radio, RefreshCw, Crown, Clock } from "lucide-react";
import type { ServicePackage } from "@/lib/services";

type Line = {
  icon: typeof Check;
  label: string;
  value: string;
  /** false renders a muted "not included" style instead of a check. */
  included: boolean;
};

/** Turns a package definition into a plain "here is what lands in your hands" list. */
function linesFor(pkg: ServicePackage): Line[] {
  if (pkg.kind === "video") {
    const is4k = pkg.slug === "4k-hd-video";
    return [
      {
        icon: Video,
        label: "Music videos",
        value: is4k
          ? "1 official 4K music video + compressed social cut"
          : "1 official HD (1080p) music video",
        included: true,
      },
      { icon: Music, label: "Tracks produced", value: "None — you supply the finished master", included: false },
      {
        icon: Radio,
        label: "Distribution",
        value: "Not included — files are delivered straight to you",
        included: false,
      },
      { icon: RefreshCw, label: "Revisions", value: "0 — one-shoot deal, delivery is final", included: false },
      { icon: Crown, label: "Ownership", value: "You keep the footage and all rights", included: true },
      {
        icon: Clock,
        label: "Turnaround",
        value: pkg.deliveryEstimate ?? "Quoted after your shoot is booked",
        included: true,
      },
    ];
  }

  const isFoundation = pkg.slug === "foundation";
  const distributed = isFoundation || pkg.slug === "full-hybrid";
  const bonusVideos = pkg.slug === "full-hybrid" ? 2 : pkg.slug === "visual-push" ? 1 : 0;
  const revisions =
    pkg.slug === "full-hybrid" ? "3 revision rounds" : pkg.slug === "visual-push" ? "2 revision rounds" : "0 — direct-to-master pipeline";

  return [
    {
      icon: Music,
      label: "Tracks",
      value: isFoundation
        ? "1 mastered track per order · 10 on the album bundle"
        : "1 fully produced track per order · 10 on the album bundle",
      included: true,
    },
    {
      icon: Video,
      label: "Music videos",
      value: bonusVideos
        ? `${bonusVideos} official music video${bonusVideos > 1 ? "s" : ""} — included when you complete the 10-track album bundle`
        : "Not included — add a video package separately",
      included: bonusVideos > 0,
    },
    {
      icon: Radio,
      label: "Distribution",
      value: distributed
        ? "Spotify, Apple Music and all major platforms — handled for you"
        : "Not included — finished tracks come straight back to you to release",
      included: distributed,
    },
    { icon: RefreshCw, label: "Revisions", value: revisions, included: pkg.slug !== "foundation" },
    {
      icon: Crown,
      label: "Ownership & royalties",
      value: distributed
        ? "You keep 100% of masters, publishing and royalties — zero backend cuts"
        : "You keep 100% of the finished tracks and every right to them",
      included: true,
    },
    {
      icon: Clock,
      label: "Turnaround",
      value: isFoundation ? "5–7 business days from approved submission" : "Scheduled with you after intake",
      included: true,
    },
  ];
}

/**
 * Live "what you'll receive" checklist. Updates the moment a tier is picked so
 * artists can confirm tracks, videos and distribution before paying.
 */
export function DeliverablesChecklist({
  pkg,
  className = "",
}: {
  pkg: ServicePackage | null;
  className?: string;
}) {
  return (
    <section
      aria-labelledby="deliverables-heading"
      aria-live="polite"
      className={`border border-border bg-background/45 p-6 backdrop-blur-sm sm:p-8 ${className}`}
    >
      <h3
        id="deliverables-heading"
        className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
      >
        What you&apos;ll receive
      </h3>

      {!pkg ? (
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          Pick a pipeline above and this checklist fills in instantly — tracks, videos,
          distribution and turnaround, all before you pay a cent.
        </p>
      ) : (
        <>
          <p className="mt-3 font-display text-xl font-semibold" style={{ color: pkg.color }}>
            {pkg.title}
          </p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {pkg.tagline}
          </p>

          <ul className="mt-6 space-y-4">
            {linesFor(pkg).map((line) => {
              const Icon = line.icon;
              return (
                <li key={line.label} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`mt-[2px] flex h-5 w-5 flex-none items-center justify-center border ${
                      line.included ? "border-current" : "border-border text-muted-foreground"
                    }`}
                    style={line.included ? { color: pkg.color } : undefined}
                  >
                    {line.included ? <Check size={12} /> : <Minus size={12} />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      <Icon size={12} aria-hidden />
                      {line.label}
                    </span>
                    <span
                      className={`mt-1 block text-sm leading-relaxed ${
                        line.included ? "text-white/90" : "text-muted-foreground"
                      }`}
                    >
                      {line.value}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
