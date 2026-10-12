import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Facebook, Instagram, ShoppingBag, Youtube } from "lucide-react";

import { AudiomackIcon } from "@/components/AudiomackIcon";
import { HowItWorksModal } from "@/components/HowItWorksModal";
import { PartnerDistributionLockup } from "@/components/PartnerDistributionLockup";
import { TermsModal } from "@/components/TermsModal";
import { ThreadsIcon } from "@/components/ThreadsIcon";
import { TikTokIcon } from "@/components/TikTokIcon";
import { MERCH_URL } from "@/lib/site-nav";

const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@HybridAIRecords";

const SOCIAL_LINKS = [
  { icon: Facebook, label: "Facebook", href: "https://www.facebook.com/people/Hybrid-AI-Records-LLC/61590094667469/" },
  { icon: ThreadsIcon, label: "Threads", href: "https://www.threads.com/@hybridairecords" },
  { icon: Youtube, label: "YouTube", href: YOUTUBE_CHANNEL_URL },
  { icon: TikTokIcon, label: "TikTok", href: "https://www.tiktok.com/@spaulshaw4" },
  { icon: Instagram, label: "Instagram", href: "https://www.instagram.com/hybridairecords" },
  { icon: AudiomackIcon, label: "Audiomack", href: "https://audiomack.com/spaulshaw4" },
  { icon: ShoppingBag, label: "Merch", href: MERCH_URL },
] as const;

const LINK_CLASS = "text-sm text-zinc-300 transition-colors hover:text-white";

export function Footer() {
  const navigate = useNavigate();
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  return (
    <footer className="w-full border-t border-white/10 pb-28 text-zinc-300 lg:pb-10">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-6 pt-8 text-center">
        <PartnerDistributionLockup />
      </div>

      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-10 px-6 pb-10 md:grid-cols-3 md:items-start">
        <div className="text-center md:text-start">
          <p className="text-base font-semibold text-white">Hybrid AI Records LLC</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-300">
            Creator Autonomy. Fair Royalties. Studio Infrastructure.
          </p>
        </div>

        <nav aria-label="Footer" className="flex flex-col items-center gap-3">
          <button type="button" onClick={() => setHowItWorksOpen(true)} className={LINK_CLASS}>
            How It Works
          </button>
          <Link to="/plans" className={LINK_CLASS}>
            Pricing & Plans
          </Link>
          <Link to="/portal" search={{ tab: "radio" }} className={LINK_CLASS}>
            24/7 Radio
          </Link>
          <Link to="/portal" search={{ tab: "catalog_merch" }} className={LINK_CLASS}>
            Catalog
          </Link>
          <button type="button" onClick={() => setTermsOpen(true)} className={LINK_CLASS}>
            Terms of Service
          </button>
          <Link to="/privacy" className={LINK_CLASS}>
            Privacy Policy
          </Link>
        </nav>

        <div className="flex flex-col items-center gap-3 text-center md:items-end md:text-end">
          <a href="mailto:support@hybrid-ai-records.com" className={LINK_CLASS}>
            support@hybrid-ai-records.com
          </a>
          <p className="text-sm text-zinc-300">Knoxville, TN</p>
          <div className="flex flex-wrap justify-center gap-2 md:justify-end">
            {SOCIAL_LINKS.map(({ icon: Icon, label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={label}
                className="grid h-10 w-10 place-items-center rounded-full border border-transparent bg-zinc-900/40 text-slate-200 backdrop-blur transition-colors hover:border-blue-500/50 hover:bg-zinc-900/60 hover:text-white"
              >
                <Icon size={16} />
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-white/10 px-6 py-6 text-center text-xs text-zinc-300">
        © 2026 Hybrid AI Records - Independent Label - All rights reserved.
      </div>

      <HowItWorksModal
        open={howItWorksOpen}
        onClose={() => setHowItWorksOpen(false)}
        onSubmit={() => {
          setHowItWorksOpen(false);
          void navigate({ to: "/engine" });
        }}
      />
      <TermsModal open={termsOpen} onClose={() => setTermsOpen(false)} />
    </footer>
  );
}
