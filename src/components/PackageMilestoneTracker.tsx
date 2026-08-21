import { useMemo } from "react";
import { CheckCircle2, Circle, Radio } from "lucide-react";
import type { ServicePackage } from "@/lib/services";

type Milestone = {
  key: string;
  title: string;
  detail: string;
  timing: string;
  /** Whether the artist or the studio owns this step. */
  owner: "You" | "Studio";
};

/**
 * True when the label actually releases the music for this package. Packages
 * whose distribution line starts with "None" hand the masters back instead.
 */
export function hasDistribution(pkg?: ServicePackage | null) {
  if (!pkg || pkg.kind === "video") return false;
  const line = pkg.distribution?.trim().toLowerCase() ?? "";
  if (!line) return false;
  return !line.startsWith("none");
}

function buildMilestones(pkg: ServicePackage): Milestone[] {
  const isVideo = pkg.kind === "video";

  const base: Milestone[] = [
    {
      key: "intake",
      title: "Intake & application",
      detail: `You pick ${pkg.title}, send your artist name and contact email, and tell us how you want to start.`,
      timing: "Same day",
      owner: "You",
    },
    {
      key: "assets",
      title: "Assets received",
      detail: isVideo
        ? "Final master audio, footage or stills, logo, and your treatment/shot list land in the studio inbox."
        : "Lyrics, vocals, stems, or reference links land in the studio inbox — or you book your vocal session.",
      timing: "Same day",
      owner: "You",
    },
    {
      key: "review",
      title: "Review & consultation",
      detail:
        "We check your material against our content policy and confirm scope, timeline, and anything missing by email.",
      timing: "1–2 business days",
      owner: "Studio",
    },
    {
      key: "production",
      title: isVideo ? "Shoot & edit (one-shoot deal)" : "Production & engineering",
      detail: isVideo
        ? "The single shoot and edit pass happens here. Flag anything now — there are 0 revisions after delivery."
        : pkg.tagline.includes("0 Revisions")
          ? "Direct-to-master production runs straight through — no revision rounds on this tier."
          : "Production, mixing, and your included revision rounds run in this window.",
      timing: pkg.deliveryEstimate ?? "5–7 business days",
      owner: "Studio",
    },
    {
      key: "qc",
      title: "Quality check & master lock",
      detail: isVideo
        ? "Colour, audio sync, and export QC. Once the master is locked the delivery is final — no returns."
        : "Final mastering pass and loudness QC. The master is locked once it clears.",
      timing: "1 business day",
      owner: "Studio",
    },
    {
      key: "delivery",
      title: "Delivery",
      detail: isVideo
        ? "Your final HD/4K files are delivered by email link. Delivery is final: 0 revisions, no returns."
        : "Your finished masters are delivered by email link, ready to release.",
      timing: pkg.deliveryEstimate ? "On the estimate above" : "5–7 business days",
      owner: "Studio",
    },
  ];

  if (hasDistribution(pkg)) {
    base.push({
      key: "distribution",
      title: "Distribution & release",
      detail:
        pkg.distribution ??
        "We deliver your release to Spotify, Apple Music, and every major platform under the label.",
      timing: "3–7 business days after delivery",
      owner: "Studio",
    });
  }

  return base;
}

/**
 * Static milestone map for the currently selected package: what happens from
 * intake to delivery, who owns each step, and the distribution stage when the
 * label actually releases the record. Complements the reference-code lookup in
 * the delivery status tracker, which shows a live order's position.
 */
export function PackageMilestoneTracker({
  pkg,
  className = "",
}: {
  pkg?: ServicePackage | null;
  className?: string;
}) {
  const milestones = useMemo(() => (pkg ? buildMilestones(pkg) : []), [pkg]);

  if (!pkg) {
    return (
      <div
        className={`border border-border bg-background/40 p-6 backdrop-blur-sm ${className}`}
        aria-live="polite"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Package status tracker
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Pick a package above to see its milestone map — intake, review, production, delivery, and
          distribution where it applies.
        </p>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="package-milestones-heading"
      className={`border border-border bg-background/40 p-6 backdrop-blur-sm sm:p-8 ${className}`}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Package status tracker
      </p>
      <h3
        id="package-milestones-heading"
        className="mt-2 text-xl font-semibold tracking-tight text-white"
      >
        <span style={{ color: pkg.color }}>{pkg.title}</span> — intake to{" "}
        {hasDistribution(pkg) ? "distribution" : "delivery"}
      </h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Every milestone in this pipeline, in order, with who owns it and how long it typically
        takes.
        {hasDistribution(pkg)
          ? " This tier ends with us releasing the record under the label."
          : " This tier ends with the finished files handed back to you."}
      </p>

      <ol className="mt-8 space-y-0">
        {milestones.map((m, i) => {
          const last = i === milestones.length - 1;
          const isDistribution = m.key === "distribution";
          return (
            <li key={m.key} className="relative flex gap-4 pb-8 last:pb-0">
              {!last && (
                <span
                  aria-hidden
                  className="absolute left-[11px] top-7 h-[calc(100%-1.25rem)] w-px bg-border"
                />
              )}
              <span
                aria-hidden
                className="relative z-10 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-strong bg-background"
                style={last ? { borderColor: pkg.color } : undefined}
              >
                {isDistribution ? (
                  <Radio size={12} style={{ color: pkg.color }} />
                ) : last ? (
                  <CheckCircle2 size={13} style={{ color: pkg.color }} />
                ) : (
                  <Circle size={9} className="text-muted-foreground" />
                )}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    Step {String(i + 1).padStart(2, "0")}
                  </span>
                  <h4 className="text-base font-semibold text-white">{m.title}</h4>
                  <span
                    className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] ${
                      m.owner === "You"
                        ? "border-[#4b8bff]/50 text-[#4b8bff]"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {m.owner === "You" ? "Your move" : "Studio"}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-white/80">{m.detail}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {m.timing}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        Timings are typical business-day windows and start once your assets are complete. Track a
        live order by reference code in the delivery status tracker below.
      </p>
    </section>
  );
}
