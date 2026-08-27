import { BadgeCheck, Facebook, Instagram, Music2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Badge = { label: string; Icon: LucideIcon; href: string };

const BADGES: Badge[] = [
  {
    label: "Facebook",
    Icon: Facebook,
    href: "https://www.facebook.com/people/Hybrid-AI-Records-LLC/61590094667469/",
  },
  {
    label: "Instagram",
    Icon: Instagram,
    href: "https://www.instagram.com/hybridairecords",
  },
  { label: "TikTok", Icon: Music2, href: "https://www.tiktok.com/@spaulshaw4" },
];

export function VerifiedBadges() {
  return (
    <div className="mt-16 border-t border-transparent pt-8">
      <p className="font-mono text-[0.65rem] uppercase tracking-[0.28em] text-muted-foreground">
        Verified accounts
      </p>

      <ul className="mt-4 flex flex-wrap gap-3">
        {BADGES.map(({ label, Icon, href }) => (
          <li key={label}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${label} — verified official profile (opens in a new tab)`}
              className="flex items-center gap-2 rounded-full border border-transparent bg-zinc-900/40 px-4 py-2 text-white backdrop-blur transition-colors hover:border-blue-500/50 hover:bg-zinc-900/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
            >
              <Icon className="size-4 text-slate-200" aria-hidden="true" />
              <span className="text-xs font-medium text-white">{label}</span>
              <BadgeCheck className="size-4 text-primary" aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>


      <p className="mt-4 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Hybrid AI Records LLC maintains verified official profiles on these platforms. Verification
        confirms account authenticity on each platform and is not an endorsement, partnership, or
        certification by those companies.
      </p>
    </div>
  );
}
