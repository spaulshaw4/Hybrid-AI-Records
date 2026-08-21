import { Clock, Globe2, Send } from "lucide-react";

/**
 * Distribution-only explainer shown directly under The Foundation package.
 * No production language — this tier only moves finished masters to stores.
 */
export function FoundationDeliveryNote({ className = "" }: { className?: string }) {
  return (
    <section
      aria-label="How delivery works for The Foundation"
      className={`bg-background/30 px-8 py-6 backdrop-blur-sm ${className}`}
    >
      <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-[#4b8bff]">
        How delivery works
      </h3>
      <p className="mt-3 text-xs leading-relaxed text-white/70">
        The Foundation is distribution only — you send a finished, mastered file and we deliver it
        to stores under your name. No writing, recording, or production is included.
      </p>

      <ul className="mt-4 space-y-3">
        <li className="flex items-start gap-2 text-xs leading-relaxed text-white/70">
          <Send size={12} aria-hidden className="mt-[3px] flex-none text-[#e11d2e]" />
          <span>
            <span className="text-white">Files &amp; metadata (day 0–2):</span> after checkout you
            upload your master, artwork, and release info.
          </span>
        </li>
        <li className="flex items-start gap-2 text-xs leading-relaxed text-white/70">
          <Clock size={12} aria-hidden className="mt-[3px] flex-none text-[#e11d2e]" />
          <span>
            <span className="text-white">Delivery to stores (2–5 business days):</span> we review
            specs and ship the release. Store review can add 1–2 weeks, so pick a release date at
            least 3 weeks out.
          </span>
        </li>
        <li className="flex items-start gap-2 text-xs leading-relaxed text-white/70">
          <Globe2 size={12} aria-hidden className="mt-[3px] flex-none text-[#e11d2e]" />
          <span>
            <span className="text-white">Where it goes:</span> Spotify, Apple Music, Amazon Music,
            YouTube Music &amp; Content ID, TikTok, Instagram/Facebook, Deezer, Tidal, Pandora,
            iHeartRadio, and other major global stores.
          </span>
        </li>
      </ul>

      <p className="mt-4 font-mono text-[10px] uppercase leading-relaxed tracking-[0.16em] text-muted-foreground">
        You keep 100% of your masters · no label royalties
      </p>
    </section>
  );
}
