import { Clock } from "lucide-react";
import { VIDEO_SERVICES } from "@/lib/services";

/**
 * Delivery Timeline FAQ for the video packages. Answers the two questions the
 * studio gets most: what makes a turnaround slip, and when HD vs 4K lands.
 * Turnaround numbers stay sourced from services.ts so there is one source of truth.
 */
const FAQ: { q: string; a: string }[] = [
  {
    q: "When does the delivery clock start?",
    a: "The clock starts on the shoot date — not on the day you pay. Business days only: weekends and public holidays never count toward the window.",
  },
  {
    q: "What can push my turnaround out?",
    a: "Missing or late assets (final master, footage, stills, logos, treatment), swapping the master audio after the shoot, unreadable or low-resolution source files, licensing clearance on third-party footage, and slow sign-off on titles or credits. Every day we wait on an asset is a day added to the window.",
  },
  {
    q: "What keeps it fast?",
    a: "Send one complete asset pack before checkout, spell on-screen text exactly as it should appear, and confirm your master is truly final. Complete packs almost always land at the early end of the window.",
  },
  {
    q: "How is 4K different from HD?",
    a: "4K carries a cinematic colour grade pass and a separate social cut-down, plus heavier render and export times at Ultra HD resolution. That extra grade and render work is the whole reason the 4K window runs longer than HD.",
  },
  {
    q: "How will I know it's ready?",
    a: "You get an email with the download link the moment the cut is exported. One cut is delivered — 0 revisions, delivery is final, and video sales are non-refundable.",
  },
];

export function DeliveryTimelineFaq({ className = "" }: { className?: string }) {
  return (
    <section className={`border border-border bg-background/30 backdrop-blur-sm ${className}`}>
      <div className="border-b border-border px-6 py-5 sm:px-8">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          / Delivery Timeline — FAQ
        </span>
        <h3 className="mt-2 font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
          When your footage lands.
        </h3>
      </div>

      <dl className="grid grid-cols-1 gap-px border-b border-border bg-border/60 sm:grid-cols-2">
        {VIDEO_SERVICES.map((s) => (
          <div key={s.slug} className="bg-background/40 px-6 py-5 sm:px-8">
            <dt className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: s.color }}>
              {s.title}
            </dt>
            <dd className="mt-2 flex items-start gap-2 text-sm leading-relaxed text-white/80">
              <Clock size={14} aria-hidden className="mt-[3px] flex-none text-[#4b8bff]" />
              <span>{s.deliveryEstimate ?? "Delivery window confirmed at booking."}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="divide-y divide-border">
        {FAQ.map((item) => (
          <details key={item.q} className="group px-6 py-4 sm:px-8">
            <summary className="cursor-pointer list-none text-sm font-semibold text-white transition-colors hover:text-[#4b8bff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#4b8bff]">
              {item.q}
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-white/70">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
