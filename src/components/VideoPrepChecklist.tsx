import { Check } from "lucide-react";

/**
 * One-shoot preparation checklist for the video packages. Video tiers ship with
 * 0 revisions, so this spells out exactly what must be locked before we start.
 */
const GROUPS: { title: string; items: string[] }[] = [
  {
    title: "What to submit",
    items: [
      "Final master audio — the exact mix that will be released.",
      "Any footage, stills, or brand assets you want in the cut.",
      "Logo files and on-screen text (titles, credits, handles) spelled correctly.",
      "A short treatment or shot list: mood, references, and must-have moments.",
    ],
  },
  {
    title: "Format expectations",
    items: [
      "Audio: WAV / AIFF 24-bit 44.1kHz or higher, or 320kbps MP3.",
      "Footage: MP4, MOV, M4V, or WEBM — highest resolution you have.",
      "Stills & logos: PNG or JPG, 1080p or larger (transparent PNG for logos).",
      "Treatment: PDF or DOC, one page is plenty.",
    ],
  },
  {
    title: "Timing & policy",
    items: [
      "Assets are locked at payment — send everything before you check out.",
      "Production starts once the full asset pack is received.",
      "Standard delivery: 7–10 business days · 4K: 10–14 business days.",
      "One cut is delivered. Delivery is final: 0 revisions, no re-edits after handoff.",
      "No returns policy: video sales are final — no refunds, returns, or exchanges.",
    ],
  },

];

export function VideoPrepChecklist({ className = "" }: { className?: string }) {
  return (
    <section
      aria-labelledby="video-prep-title"
      className={`border border-border-strong bg-background/40 backdrop-blur-sm ${className}`}
    >
      <div className="border-b border-border px-6 py-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          One-shoot deal · 0 revisions · no returns · delivery final
        </div>
        <h3
          id="video-prep-title"
          className="mt-2 font-display text-xl font-semibold text-white"
        >
          Video preparation checklist
        </h3>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Because there are no revision rounds, everything below has to be final before production
          starts. Work through it once and your cut lands right the first time.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-px bg-border/60 md:grid-cols-3">
        {GROUPS.map((group) => (
          <div key={group.title} className="bg-background/40 px-6 py-5">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#4b8bff]">
              {group.title}
            </h4>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-white/80">
              {group.items.map((item) => (
                <li key={item} className="flex gap-3">
                  <Check size={15} aria-hidden className="mt-0.5 flex-none text-[#e11d2e]" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
