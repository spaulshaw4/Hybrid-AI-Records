import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


import keliasCover from "@/assets/kelias-i-save-cover.png.asset.json";
import { CoverImage } from "@/components/CoverImage";
import { ALBUMS, STREAM_TRACKS, albumCoverSrc, videoPosterFallbacks, videoPosterSrc } from "@/lib/radio-tracks";
import { useEffect, useMemo, useRef, useState } from "react";
import { trackHowItWorksCtaClick } from "@/lib/cta-analytics";


import { Play, ArrowUpRight, ArrowDown, Youtube, Instagram, Link as LinkIcon, ShoppingBag, Facebook, ShieldCheck, Check, Minus, Search, X } from "lucide-react";
import { useStripeCheckout } from "@/hooks/useStripeCheckout";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { ApplicationModal } from "@/components/ApplicationModal";
import { InstallAppButton } from "@/components/InstallAppButton";
import { AboutModal } from "@/components/AboutModal";
import { TermsModal } from "@/components/TermsModal";

import { DivisionCrest } from "@/components/DivisionCrest";
import { DivisionFooterBadge } from "@/components/LivingBackground";

import { crestPreloadLink, resolveDivision, type Division } from "@/lib/divisions";
import { buildCatalogJsonLd, buildOrganizationPodcastJsonLd } from "@/lib/release-schema";
import { JESTER_DIVISION_NAME, JESTER_DIVISION_SHORT_NAME } from "@/lib/division-settings";
import { ContactModal } from "@/components/ContactModal";
import { QuickOrderForm } from "@/components/QuickOrderForm";
import { PACKAGE_SLUGS, type OrderPackage } from "@/lib/order-link";
import { ArtistFileDrop } from "@/components/ArtistFileDrop";
import { HowItWorksModal } from "@/components/HowItWorksModal";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/** Rows for the $50 / $100 / $150 package comparison table (Foundation, Visual Push, Full Hybrid). */
const COMPARISON_ROWS: { label: string; values: (boolean | string)[] }[] = [
  { label: "Global distribution (Spotify, Apple Music, etc.)", values: [true, false, true] },
  { label: "Full track production from your vocals/lyrics", values: [false, true, true] },
  { label: "Commercial mixing & mastering", values: [false, true, true] },
  { label: "Official music videos (per 10-track album)", values: ["—", "1 video", "2 videos"] },
  { label: "Released under the Hybrid AI Records label", values: ["Optional", false, true] },
  { label: "You keep 100% masters & royalties", values: [true, true, true] },
  { label: "Mix revision rounds included", values: ["None", "2", "2"] },
  { label: "Typical turnaround", values: ["5–7 days", "7–14 days", "10–21 days"] },
  { label: "10-track bundle price", values: ["$500", "$1,000", "$1,500"] },
];

const PODCAST_EPISODES = [
  { id: "apvDJD5GTZ4", title: "Hybrid AI Records LLC Podcast — Episode 1", date: "2026" },
  { id: "VmlnfVgS13A", title: "Hybrid AI Records LLC Podcast — Episode 2", date: "2026" },
  { id: "Cqi7gTzu2ck", title: "Hybrid AI Records LLC Podcast — Episode 3", date: "2026" },
  { id: "Fouvaa-n-h0", title: "The Tuesday Update — Episode 1", date: "2026" },
  { id: "o-t23mqANZI", title: "Tuesday Update — Episode 2", date: "2026" },
  { id: "kzW0erPIWKs", title: "Tuesday Update — Episode 3", date: "2026" },
  { id: "o6_HrEh0VWk", title: "Jesse & Tuesday Update — Episode 4", date: "2026" },
  { id: "nLIbO5bIgss", title: "Tuesday Update — Episode 5", date: "2026" },
  { id: "MHZHK0qos1Q", title: "Tuesday Update — Episode 6", date: "2026" },
];



const REVISION_POLICY: {
  eyebrow: string;
  title: string;
  color: string;
  points: string[];
}[] = [
  {
    eyebrow: "Counts as a revision",
    title: "What We Adjust",
    color: "#e11d2e",
    points: [
      "Mix balance changes — vocal level, instrument levels, EQ and reverb tweaks.",
      "Master loudness or tonal adjustments on the delivered mix.",
      "Timing or arrangement edits inside the existing song structure.",
      "Cover art or video text corrections on the same approved concept.",
    ],
  },
  {
    eyebrow: "One round defined",
    title: "How A Round Works",
    color: "#e4e4e7",
    points: [
      "A round is one consolidated list of notes, sent together in a single request.",
      "Notes sent after we start a round roll into the next round.",
      "Each round is returned within 2–3 business days of receipt.",
      "Approving a delivery closes that round and starts the release clock.",
    ],
  },
  {
    eyebrow: "Change of scope",
    title: "What Needs A New Quote",
    color: "#3b6fe0",
    points: [
      "New vocal recordings, added verses, or a different song entirely.",
      "Switching genre, tempo, or key after the foundation is approved.",
      "A new visual concept, new footage, or a different aspect-ratio deliverable.",
      "Anything requested after final files are approved and delivered.",
    ],
  },
];

const REVISION_ROUNDS: { pkg: string; rounds: string; note: string }[] = [
  { pkg: "The Foundation", rounds: "None", note: "Direct-to-master pipeline — no revision rounds included." },
  { pkg: "The Visual Push", rounds: "2 rounds", note: "One audio round, one visual round." },
  { pkg: "The Full Hybrid Experience", rounds: "3 rounds", note: "Audio, visual, and final polish." },
];

/** At-a-glance turnaround per tier, matching the Pricing FAQ answers. */
const TURNAROUND_BY_TIER: Record<string, string> = {
  "The Foundation": "5–7 business days",
  "The Visual Push": "10–14 business days",
  "The Full Hybrid Experience": "12–17 business days",
};

/* Shared typography + spacing tokens so every Services panel reads the same. */
const PANEL_TITLE = "mt-3 font-display text-2xl font-semibold text-foreground";
const PANEL_INTRO = "mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground";
const PANEL_TRIGGER =
  "text-left font-display text-base font-semibold uppercase tracking-widest text-foreground hover:text-[#e11d48] hover:no-underline";
const PANEL_BODY = "space-y-6 pb-2";
const PANEL_LEAD = "max-w-2xl text-sm leading-relaxed text-muted-foreground";



const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "How long does each package take?",
    a: "Standard turnaround is 5–7 business days from the moment we receive your recorded vocals. Instrumental foundations are usually back to you in 2–4 business days. Music videos add 5–10 business days depending on tier — Standard HD is faster, 4K Cinematic takes longer to render.",
  },
  {
    q: "What file formats do you accept for vocals?",
    a: "Send WAV or AIFF at 24-bit / 44.1kHz or higher for best results. We also accept high-bitrate MP3 (320kbps) or M4A if that's all you have. Send one dry vocal recording with no reverb or autotune baked in — we don't work from multi-track stem sessions. Reference tracks are welcome as separate files. Share via Google Drive, Dropbox, or WeTransfer link.",
  },
  {
    q: "How do revisions work?",
    a: "Every package includes two rounds of mix revisions at no extra cost — send all your notes together in one message per round so we can work efficiently. Additional rounds are quoted per request. Video work is planned with you before production starts, and once rendering begins video revisions are limited to color and timing fixes.",
  },
  {
    q: "What's included in the price I see?",
    a: "The listed price covers production, mixing, mastering, and delivery of your final files — and you keep 100% of your master ownership. Prices shown in EUR, GBP, NGN, and ZAR use daily exchange rates and include a 2% international processing fee, itemized separately at checkout.",
  },
  {
    q: "What happens after I pay?",
    a: "You're redirected to your Order Status page with a reference code (HAR-XXXX). Track your submission there, add notes for the team, and watch each stage move from received to in production to delivered.",
  },
];


import { useCurrency } from "@/lib/currency";
import { useMoneyFormat } from "@/lib/money-format";
import { SERVICES, type ServicePackage } from "@/lib/services";
import { PayNowModal } from "@/components/PayNowModal";

import { TikTokIcon } from "@/components/TikTokIcon";
import { ThreadsIcon } from "@/components/ThreadsIcon";
import { AudiomackIcon } from "@/components/AudiomackIcon";
import { RadioPlayer } from "@/components/RadioPlayer";

type VideoItem = { id: string; title: string; subtitle?: string };



function VideoModal({ video, onClose }: { video: VideoItem | null; onClose: () => void }) {
  const playerRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [video?.id]);

  useEffect(() => {
    if (!video) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [video, onClose]);

  // Smoothly bring the freshly-opened player into view and hand it keyboard focus.
  useEffect(() => {
    if (!video) return;
    const frame = requestAnimationFrame(() => {
      const node = playerRef.current;
      if (!node) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      node.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [video]);

  if (!video) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={video.title}
      className="fixed inset-0 z-[100] flex animate-fade-in flex-col overflow-y-auto bg-surface"
      onClick={onClose}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-6 py-4">
        <div className="min-w-0 pe-4">
          <div className="truncate font-display text-sm font-bold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)] sm:text-base">{video.title}</div>
          {video.subtitle && (
            <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              {video.subtitle}
            </div>
          )}
        </div>
        <button
          aria-label="Close video"
          onClick={onClose}
          className="grid h-10 w-10 shrink-0 place-items-center border border-border text-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex flex-1 items-start justify-center p-4 sm:items-center sm:p-8" onClick={(e) => e.stopPropagation()}>
        <div
          ref={playerRef}
          tabIndex={-1}
          className="relative w-full max-w-6xl scroll-mt-24 animate-scale-in outline-none"
        >
          <div className="relative aspect-video max-h-[85dvh] w-full overflow-hidden border border-border-strong bg-ink shadow-[var(--shadow-hard)] transition-shadow duration-500 focus-within:shadow-[0_0_48px_-8px_rgba(225,29,46,0.55)]">
            <iframe
              key={video.id}
              src={`https://www.youtube.com/embed/${video.id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
              title={video.title}
              className="absolute inset-0 h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
              allowFullScreen
            />
          </div>

          <div className="mt-4 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            <span>Esc to close</span>
            <button
              type="button"
              onClick={() => {
                const url = `${window.location.origin}/?v=${video.id}`;
                navigator.clipboard?.writeText(url).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              className="inline-flex items-center gap-1.5 uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-primary"
            >
              {copied ? "Link copied" : "Copy share link"}
            </button>
            <a
              href={`https://www.youtube.com/watch?v=${video.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary"
            >
              Open on YouTube <ArrowUpRight size={12} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

import { WORDMARK_LINK } from "@/components/Wordmark";
import { BrandEagle } from "@/components/BrandEagle";
import usaEmblem from "@/assets/divisions/usa.png";
import { VerifiedBadges } from "@/components/VerifiedBadges";
import { WhatsAppSupportCta } from "@/components/WhatsAppSupportCta";
import { SupportRequestProvider } from "@/lib/support-request";



import podcastCover from "@/assets/hybrid-podcast-logo-v2.png.asset.json";



export const Route = createFileRoute("/")({
  head: () => {
    const base = pageHead({
      path: "/",
      title: `Hybrid AI Records | Label & ${JESTER_DIVISION_SHORT_NAME}`,
      description: `Hybrid AI Records LLC is an SBA Veteran-Certified independent label — release-ready music, artist ownership, catalog videos, the Hybrid AI podcast, and ${JESTER_DIVISION_NAME}.`,
      // Share-card copy is tuned for Facebook / X / Instagram link previews.
      socialTitle: "Hybrid AI Records | Start Your Project",
      socialDescription:
        "Raw Words. Real Music. Global Impact. Choose your production tier and start your project today.",
      type: "website",
      imageAlt: "Hybrid AI Records — eagle crest share banner for the SBA Veteran-Certified independent label",
    });

    return {
      meta: base.meta,
      links: [
        ...base.links,
        // Crests on the first catalog row: preloaded (deduplicated by division)
        // so their badges never flash an empty square or nudge the card text.
        ...[...new Set(RELEASES.slice(0, 3).map((r) => resolveDivision(r)))].map((d) =>
          crestPreloadLink(d),
        ),
      ],
      scripts: [
        {
          type: "application/ld+json",
          children: JSON.stringify(buildOrganizationPodcastJsonLd(PODCAST_EPISODES, podcastCover.url)),
        },
        {
          type: "application/ld+json",
          children: JSON.stringify(buildCatalogJsonLd(RELEASES)),
        },
      ],
    };
  },
  // ?v=<youtube id> deep-links straight into a release or podcast video.
  validateSearch: (search: Record<string, unknown>): { v?: string } =>
    typeof search.v === "string" && search.v ? { v: search.v } : {},
  errorComponent: RouteErrorFallback,
  component: Home,
});


const METRICS: { value: string; label: string; valueColor: string; labelColor: string }[] = [
  { value: "100%", label: "Artist Ownership", valueColor: "text-primary", labelColor: "text-muted-foreground" },
  { value: "0%", label: "Label Royalties", valueColor: "text-[#3b82f6]", labelColor: "text-[#3b82f6]" },
  { value: "Fixed", label: "Per-Track Cost", valueColor: "text-white", labelColor: "text-white" },
  { value: "Global", label: "Digital Rollout", valueColor: "text-primary", labelColor: "text-primary" },
];


// Real releases from the Hybrid AI Records YouTube channel.
type Release = { id: string; title: string; artist: string; year: string; previewUrl?: string; cover?: string; division?: Division };
const RELEASES: Release[] = [
  { id: "F5XrwINZiJY", title: "Coordinates Of Light", artist: "Stephen P. Shaw", year: "2026", division: "usa" },
  { id: "MgBDH8v2YZk", title: "Kelias Į Save", artist: "Alina Shaw", year: "2026", cover: keliasCover.url, division: "lithuania" },
  { id: "6_uuoK4NFrs", title: "Voices Before The Fall", artist: "Sage Zimba", year: "2026", division: "nigeria" },
  { id: "-A1GwAwFyyE", title: "The Red", artist: "Matthew Stern", year: "2026" },
  { id: "-HpZUqE5S4g", title: "Home Was Never A Place", artist: "Alina Shaw", year: "2026", division: "usa" },
  { id: "dwm3aI8f7JI", title: "What I Told The Fire At 3am", artist: "Philip S. Thomas — The Jester AI", year: "2026", division: "jester" },
  { id: "PGZHKAAcjJ0", title: "Leaving Footprints", artist: "Philip S. Thomas — The Jester AI", year: "2026", division: "jester" },

  { id: "xjx5qA0wVMw", title: "Bill Collector's Nebula", artist: "Stephen P. Shaw", year: "2026" },
  { id: "paFLmyfICCA", title: "The Jester's Summon: The Long Walk To Court", artist: "Stephen P. Shaw feat. Brian Frank & Philip S. Thomas", year: "2026", division: "usa" },
  { id: "Nl7_4He6IsE", title: "The Ringer", artist: "Stephen P. Shaw", year: "2026", division: "jester" },
  { id: "PjiM_Vunr4c", title: "Never Missed A Beat", artist: "Stacey LA Bradbury", year: "2026" },
  { id: "5BL_fIWkVK4", title: "White Sand Palm Trees", artist: "Stacey LA Bradbury", year: "2026" },
  { id: "XyXh0dpAlX0", title: "Forever Love", artist: "Stacey LA Bradbury", year: "2026" },
  { id: "fI_y31AhZhY", title: "Africa", artist: "Sage Zimba", year: "2026", division: "nigeria" },
];

export const CATALOG_RELEASES = RELEASES;



const SPOTIFY_PLAYLIST_URL = "https://open.spotify.com/playlist/7hc4GrFq9A9l1e0Xve39r8";



const ytWatch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

const YOUTUBE_URL = "https://www.youtube.com/@HybridAIRecordsPodcast";
const YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@HybridAIRecords";

function Home() {
  const { v: videoParam } = Route.useSearch();
  const navigate = useNavigate({ from: "/" });

  // The open video lives in the URL so any artist click is shareable.
  const activeVideo = useMemo<VideoItem | null>(() => {
    if (!videoParam) return null;
    const release = RELEASES.find((r) => r.id === videoParam);
    if (release) return { id: release.id, title: release.title, subtitle: release.artist };
    const episode = PODCAST_EPISODES.find((e) => e.id === videoParam);
    if (episode) return { id: episode.id, title: episode.title, subtitle: episode.date };
    return null;
  }, [videoParam]);

  const openVideo = (item: VideoItem) =>
    navigate({ search: { v: item.id } });
  const closeVideo = () => navigate({ search: {}, replace: true });
  const { openCheckout, closeCheckout, isOpen: checkoutOpen, checkoutElement } = useStripeCheckout();
  const currency = useCurrency();
  const { label: priceLabel } = useMoneyFormat();
  const [applyPackage, setApplyPackage] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  
  const [contactOpen, setContactOpen] = useState(false);
  const [howItWorksOpen, setHowItWorksOpen] = useState(false);

  const openContact = (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    setContactOpen(true);
  };

  const openAbout = (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    setAboutOpen(true);
  };

  const openHowItWorks = (e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    setHowItWorksOpen(true);
  };

  const buyNow = (priceId: string) => {
    openCheckout({
      priceId,
      currency,
      returnUrl: `${window.location.origin}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    });
  };

  const [payNow, setPayNow] = useState<ServicePackage | null>(null);

  const startPaidOrder = (pkg: ServicePackage, reference: string, email: string) => {
    setPayNow(null);
    openCheckout({
      priceId: pkg.priceIdSingle,
      currency,
      customerEmail: email,
      trackReference: reference,
      returnUrl: `${window.location.origin}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    });
  };

  const [highlightCatalog, setHighlightCatalog] = useState(false);
  // Polite live region text so screen readers hear where a smooth scroll landed.
  const [scrollAnnouncement, setScrollAnnouncement] = useState("");


  /**
   * Shared smooth-scroll handler: scrolls to a section, moves keyboard focus to
   * its heading (falling back to the section itself), updates the hash, and
   * announces the destination to assistive technology.
   */
  const scrollToAnchor = (
    e: React.MouseEvent<HTMLAnchorElement>,
    sectionId: string,
    headingId: string,
    announcement: string,
  ) => {
    const target = document.getElementById(sectionId);
    if (!target) return; // let the plain anchor navigate
    e.preventDefault();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Offset by the live fixed-header height so the section title is never
    // hidden underneath it — the header is taller once the mobile menu is open.
    const header = document.querySelector("header");
    const offset = (header instanceof HTMLElement ? header.offsetHeight : 64) + 12;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });

    const focusTarget = (document.getElementById(headingId) ?? target) as HTMLElement;
    if (!focusTarget.hasAttribute("tabindex")) focusTarget.setAttribute("tabindex", "-1");
    focusTarget.focus({ preventScroll: true });

    if (window.history.replaceState) {
      window.history.replaceState(null, "", `#${sectionId}`);
    }
    // Re-set on the next frame so repeat activations still announce.
    setScrollAnnouncement("");
    window.requestAnimationFrame(() => setScrollAnnouncement(announcement));
  };

  /** Smoothly scrolls to the catalog and briefly pulses the release cards. */
  const scrollToCatalog = (e: React.MouseEvent<HTMLAnchorElement>) => {
    scrollToAnchor(e, "catalog", "catalog-title", "Catalog section. Recent releases.");
    setHighlightCatalog(true);
    window.setTimeout(() => setHighlightCatalog(false), 2600);
  };

  /** The "Connect & Order" button, so focus can be returned to it. */
  const orderCtaRef = useRef<HTMLAnchorElement>(null);
  /** Whatever was focused right before we jumped into the order form. */
  const orderReturnFocusRef = useRef<HTMLElement | null>(null);
  /** True once *this* page pushed the `#order` entry (so Back can undo it). */
  const orderPushedRef = useRef(false);


  /** Live sticky-header height (it grows when the mobile menu is open). */
  const headerOffset = () => {
    const header = document.querySelector("header");
    return (header instanceof HTMLElement ? header.offsetHeight : 64) + 12;
  };

  /** Desired document scrollTop that puts the form just below the header. */
  const orderScrollTarget = (form: HTMLElement) =>
    Math.max(0, Math.round(form.getBoundingClientRect().top + window.scrollY - headerOffset()));

  /**
   * Scrolls the order form under the sticky header and keeps correcting for
   * ~1.2s: reveal animations, lazy images and font swaps shift the section
   * after the first scroll, which used to leave deep links a few hundred
   * pixels off (or hidden behind the header). Aborts as soon as the visitor
   * scrolls themselves.
   */
  const scrollOrderIntoView = (form: HTMLElement, behavior: ScrollBehavior) => {
    window.scrollTo({ top: orderScrollTarget(form), behavior });

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      for (const ev of ["wheel", "touchstart", "keydown"] as const) {
        window.removeEventListener(ev, cancel);
      }
    };
    for (const ev of ["wheel", "touchstart", "keydown"] as const) {
      window.addEventListener(ev, cancel, { once: true, passive: true });
    }

    const started = performance.now();
    const correct = () => {
      if (cancelled || !form.isConnected) return cancel();
      const want = orderScrollTarget(form);
      // Only nudge once the smooth scroll has effectively settled, otherwise
      // we would fight the in-flight animation.
      const drift = Math.abs(window.scrollY - want);
      if (drift > 2) window.scrollTo({ top: want, behavior: "auto" });
      if (performance.now() - started < 2600) window.requestAnimationFrame(correct);
      else cancel();
    };
    // Give the smooth scroll a beat before the first correction pass.
    window.setTimeout(() => window.requestAnimationFrame(correct), behavior === "smooth" ? 450 : 0);
  };

  /**
   * Keyboard-safe jump into the order form: scrolls (respecting reduced motion),
   * moves focus to the first field without a fragile timeout, and announces it.
   */
  const jumpToOrderForm = (updateHash = true, pkg?: OrderPackage, instant = false) => {
    const form = document.getElementById("quick-order-form");
    if (!form) return;
    // Remember where focus came from so Back can restore it exactly.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !form.contains(active)) {
      orderReturnFocusRef.current = active;
    }
    if (updateHash) {
      // One canonical shape for every entry point: /?package=<slug>#order.
      const url = new URL(window.location.href);
      if (pkg) url.searchParams.set("package", PACKAGE_SLUGS[pkg]);
      const next = `${url.pathname}${url.search}#order`;
      if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
        // pushState (not replaceState) so Back leaves the form again.
        window.history.pushState(null, "", next);
        orderPushedRef.current = true;
      }

    }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollOrderIntoView(form, reduced || instant ? "auto" : "smooth");
    const first = form.querySelector<HTMLElement>(
      "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
    );
    // Reveal animations around the section can drop focus mid-scroll, so keep
    // re-focusing across a few frames until it actually sticks (~1s max).
    if (first) {
      let attempts = 0;
      const settle = () => {
        if (document.activeElement === first) return;
        first.focus({ preventScroll: true });
        if (++attempts < 60) window.requestAnimationFrame(settle);
      };
      window.requestAnimationFrame(settle);
    }

    setScrollAnnouncement("");
    window.requestAnimationFrame(() =>
      setScrollAnnouncement("Order form. Press Escape to return to the Connect and Order button."),
    );
  };


  /** Sends focus back to whatever opened the form (falling back to the CTA). */
  const restoreOrderFocus = (announce = false) => {
    const form = document.getElementById("quick-order-form");
    const active = document.activeElement as HTMLElement | null;
    // Only steal focus if it is still inside the form (or nowhere).
    if (active && active !== document.body && form && !form.contains(active)) return;
    const target = orderReturnFocusRef.current ?? orderCtaRef.current;
    if (!target || !target.isConnected) return;
    target.focus({ preventScroll: true });
    if (announce) {
      setScrollAnnouncement("");
      window.requestAnimationFrame(() =>
        setScrollAnnouncement("Left the order form. Focus returned to the Connect and Order button."),
      );
    }
  };

  /**
   * Deep link + history: /#order scrolls to and focuses the order form, and
   * navigating back/forward off the hash restores the previous focus.
   */
  useEffect(() => {
    // The very first pass is a cold deep link: jump instantly (the browser has
    // already made its own imprecise hash jump) and let the correction loop
    // absorb any late layout shift.
    let first = true;
    const handle = () => {
      if (window.location.hash === "#order") {
        const instant = first;
        first = false;
        // Wait a frame so the form is mounted before scrolling/focusing.
        window.requestAnimationFrame(() => jumpToOrderForm(false, undefined, instant));
      } else {
        first = false;
        restoreOrderFocus(true);
      }
    };
    handle();
    // Late-loading images/fonts move the section, so re-align once on load.
    const onLoad = () => {
      if (window.location.hash !== "#order") return;
      const form = document.getElementById("quick-order-form");
      if (form) scrollOrderIntoView(form, "auto");
    };
    if (document.readyState !== "complete") window.addEventListener("load", onLoad, { once: true });
    window.addEventListener("hashchange", handle);
    window.addEventListener("popstate", handle);
    return () => {
      window.removeEventListener("load", onLoad);
      window.removeEventListener("hashchange", handle);
      window.removeEventListener("popstate", handle);
    };

    return () => {
      window.removeEventListener("hashchange", handle);
      window.removeEventListener("popstate", handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  /** Escape inside the order form sends focus back — and out of the #order entry. */
  const onOrderFormKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (window.location.hash === "#order" && orderPushedRef.current) {
      // Pop the pushed entry so Forward can return to the form.
      orderPushedRef.current = false;
      window.history.back();
      return;
    }
    if (window.location.hash === "#order") {
      // Cold deep link (a shared /#order URL): there is no entry to pop, so
      // drop the hash in place and hand focus back to the CTA ourselves.
      const url = new URL(window.location.href);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    }
    restoreOrderFocus(true);
  };





  // A secure resume link (?resume=<token>) reopens the application form so the
  // modal can restore the artist's saved draft on this device. Stored drafts no
  // longer auto-open the form — that banner cluttered the landing view.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("resume");
    if (token) setApplyPackage("foundation_single");
  }, []);


  return (
    <div className="min-h-dvh text-foreground">
      <PaymentTestModeBanner />
      {/* Wrapped in a landmark so every page node belongs to one (axe `region`). */}
      <nav aria-label="Skip links">
        <a href="#main-content" className="skip-link">Skip to content</a>
        <a href="#catalog" className="skip-link start-[12rem]">Skip to catalog</a>
      </nav>

      {/* HERO */}
      {/* Announces smooth-scroll destinations to screen readers. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {scrollAnnouncement}
      </div>

      <main id="main-content" tabIndex={-1} className="pb-32 focus:outline-none lg:pb-0">
      <section id="top" className="hero-band relative isolate overflow-hidden">

        {/* Bounded band instead of a full viewport: the headline now sits near
            the top of the fold rather than under ~1000px of empty space. */}
        <div className="relative z-10 mx-auto flex max-w-7xl flex-col justify-start px-4 pb-24 pt-6 sm:px-6 md:pb-28 md:pt-8">
          <div className="max-w-4xl">
            <p className="hero-kicker eyebrow text-slab-none mb-4" dir="auto">
              <span className="hero-kicker-independent">Independent</span> • SBA Veteran-Certified •{" "}
              <span className="hero-kicker-location">Knoxville, TN</span>
            </p>
            <h1 className="font-display text-5xl font-black uppercase leading-[0.95] tracking-tight md:text-7xl">
              <span className="hero-line-red block">RAW WORDS.</span>
              <span className="hero-line-white block">REAL MUSIC.</span>
              <span className="hero-line-blue block">GLOBAL IMPACT.</span>
            </h1>
            <p className="hero-mission mt-5 max-w-2xl text-base leading-[1.7] text-slate-200 sm:mt-6 sm:text-lg md:text-xl">
              Hybrid AI Records is an independent, SBA Veteran-Certified label built for the artists the
              industry forgot to pay. Fixed-cost, release-ready tracks. You write it — you own it.
              Every royalty, every master, forever.
            </p>


            {/* Primary visitor pathways: make music, or get distribution/video services. */}
            <div className="mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
              <Link
                to="/engine"
                className="group flex flex-col gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-md backdrop-blur-md transition-all hover:border-blue-500 hover:bg-zinc-800"
              >
                <span className="rwb-flame rwb-flame-deep font-display text-xl font-extrabold sm:text-2xl">
                  Make Your Own Song
                </span>
                <span className="text-base text-slate-100">
                  Write it, describe it, hear it in minutes. No studio, no engineer.
                </span>
                <span className="mt-2 inline-flex items-center gap-2 font-bold uppercase tracking-wider text-cyan-400 group-hover:text-cyan-300">
                  Start creating <ArrowUpRight size={15} />
                </span>
              </Link>

              <Link
                to="/portal"
                search={{ view: "services" }}
                className="group flex flex-col gap-2 rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-md backdrop-blur-md transition-all hover:border-blue-500 hover:bg-zinc-800"
              >
                <span className="rwb-flame rwb-flame-deep font-display text-xl font-extrabold sm:text-2xl">
                  Distribution & Video
                </span>
                <span className="text-base text-slate-100">
                  Get your release on streaming platforms and add a professional video.
                </span>
                <span className="mt-2 inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-[0.2em] text-[#2563eb]">
                  See packages <ArrowUpRight size={15} />
                </span>
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/artists" className="btn-ghost">
                Listen & Download Music
              </Link>
              <InstallAppButton />
            </div>




          </div>
        </div>
      </section>










      {/* CATALOG */}
      <section id="catalog" aria-labelledby="catalog-title" className="relative scroll-mt-20 border-t border-border py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-16 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <h2 id="catalog-title" tabIndex={-1} className="rwb-flame rwb-flame-deep font-display text-[clamp(1.75rem,6vw,3.75rem)] font-extrabold leading-[1.15] tracking-tight outline-none">
                <span className="block">Hybrid AI Records</span>
                <span className="mt-1 block font-extrabold leading-[1.15]">Music Videos</span>
              </h2>


            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {RELEASES.map((r, ri) => (
              <div
                key={r.id}
                id={`release-${r.id}`}
                className={`group relative flex w-full flex-col overflow-hidden rounded-xl border bg-[#080a10] text-start shadow-lg shadow-black/40 transition-colors ${
                  highlightCatalog
                    ? "animate-pulse border-primary shadow-[0_0_36px_-6px_rgba(225,29,46,0.75)]"
                    : "border-zinc-800/60 hover:border-amber-500/40"
                }`}
              >
                <button
                  type="button"
                  onClick={() => openVideo({ id: r.id, title: r.title, subtitle: r.artist })}
                  className="relative aspect-video w-full overflow-hidden rounded-t-xl bg-zinc-950"
                  aria-label={`Play video: ${r.title} by ${r.artist}`}
                >
                  <CoverImage
                    src={videoPosterSrc(r.id)}
                    fallbackSrc={videoPosterFallbacks(r.id)}
                    alt={`${r.title} by ${r.artist} — official Hybrid AI Records music video`}
                    priority={ri < 4}
                    sizes="(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw"
                    width={1280}
                    height={720}
                    className="video-poster h-full w-full object-cover object-center transition-transform duration-700 group-hover:scale-[1.03]"
                  />
                  <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/95 via-background/10 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                  <span className="pointer-events-none absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                    <span className="grid h-9 w-9 place-items-center rounded-full border border-primary bg-surface text-primary">
                      <Play size={14} fill="currentColor" />
                    </span>
                  </span>
                  <span className="pointer-events-none absolute start-2 top-2 flex items-center gap-1 border border-zinc-800/80 bg-zinc-950/80 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-400">
                    <Youtube size={10} className="text-primary" /> Video
                  </span>
                </button>
                <div className="border-t border-zinc-800/60 p-3">
                  <button
                    type="button"
                    onClick={() => openVideo({ id: r.id, title: r.title, subtitle: r.artist })}
                    className="block w-full text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b8bff]"
                    aria-label={`Play video: ${r.title} by ${r.artist}`}
                  >
                    <h3 className="whitespace-nowrap overflow-hidden text-ellipsis font-display text-sm font-bold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">
                      {r.title}
                    </h3>
                    <p className="mt-0.5 whitespace-nowrap overflow-hidden text-ellipsis text-xs text-zinc-400">
                      {r.artist}
                    </p>
                  </button>
                  <div className="mt-2 flex flex-col items-center gap-1.5">
                    <DivisionCrest release={r} size="sm" priority={ri < 3} />
                    <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-400">
                      {r.year}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PODCAST */}
      <section id="podcast" aria-labelledby="podcast-title" className="relative scroll-mt-20 border-t border-border py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-6">
            
            <h2 id="podcast-title" tabIndex={-1} className="rwb-flame rwb-flame-deep min-w-0 font-display text-4xl font-extrabold leading-[1.02] tracking-tight outline-none sm:text-5xl">
              The technical side of the music industry.
            </h2>

              <p className="mt-6 max-w-3xl text-base leading-relaxed text-slate-100 sm:text-lg">
                Production, distribution, ownership, and the tools that let independent artists win.
                Hosted by founder Stephen P. Shaw and the Hybrid team.
              </p>
              {/* One primary action, one quiet secondary — no stacked duplicates. */}
              <div className="mt-10 flex flex-wrap items-center gap-4">
                <a href={YOUTUBE_URL} target="_blank" rel="noreferrer" className="btn-primary">
                  <Youtube size={16} /> Watch Latest Podcast
                </a>
                <a href="#episodes" className="btn-primary">
                  Browse Episodes
                </a>
              </div>


              <ul id="episodes" className="mt-12 scroll-mt-24 divide-y divide-border border-t border-border">
                {PODCAST_EPISODES.map((ep, i) => (
                  <li key={ep.id}>
                    <button
                      type="button"
                      onClick={() => openVideo({ id: ep.id, title: ep.title, subtitle: ep.date })}
                      className="group flex w-full items-center gap-4 px-3 py-4 text-start transition-all hover:bg-primary/5 hover:text-primary hover:shadow-[inset_3px_0_0_var(--primary)]"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="relative h-14 w-24 shrink-0 overflow-hidden border border-border bg-surface">
                        <CoverImage
                          src={videoPosterSrc(ep.id)}
                          fallbackSrc={videoPosterFallbacks(ep.id)}
                          alt={`${ep.title} — Hybrid AI Records podcast episode thumbnail`}
                          sizes="192px"
                          width={1280}
                          height={720}
                          className="video-poster h-full w-full object-cover object-center"
                        />

                        <span className="pointer-events-none absolute inset-0 grid place-items-center bg-background/40 opacity-0 transition-opacity group-hover:opacity-100">
                          <Play size={14} fill="currentColor" className="text-primary" />
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-display text-sm font-bold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">
                          {ep.title}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          {ep.date}
                        </div>
                      </div>
                      <Play size={16} className="pointer-events-none shrink-0 text-muted-foreground transition-colors group-hover:text-primary" fill="currentColor" />
                    </button>
                  </li>
                ))}
              </ul>
        </div>
      </section>






      {/* HYBRID AI RADIO — SPOTIFY */}
      <section id="radio" className="relative border-t border-border py-20 md:py-28">
        <div className="relative mx-auto max-w-5xl px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="rwb-flame rwb-flame-deep font-display text-3xl font-extrabold leading-[1.05] tracking-tight sm:text-4xl md:text-5xl">
                Hybrid AI Radio — Live Feed
              </h2>
            </div>
            <span className="flex shrink-0 items-center gap-2 border border-primary/60 bg-surface px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-primary">
              <span className="relative flex h-2 w-2">
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              Live
            </span>
          </div>

          <div className="mx-auto mt-10 max-w-3xl">
            <div className="relative">
              <div className="relative">
                <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-primary">
                  24/7 Official Label Stream
                </div>
                <h3 className="heading-pop mt-3 font-display text-2xl font-extrabold leading-tight text-blue-400 sm:text-3xl">
                  Heavy AI Production <span>·</span> Commercial Loudness
                </h3>
                <p className="mt-4 max-w-xl text-sm leading-relaxed text-slate-100">
                  Every official Hybrid AI Records release — one continuous, uninterrupted broadcast. Press play and let the label run.
                </p>

                <div className="mx-auto mt-8 max-w-2xl">
                  <RadioPlayer
                    tracks={[
                      ...STREAM_TRACKS,
                      ...RELEASES.filter(
                        (r) =>
                          !STREAM_TRACKS.some(
                            (s) => s.title.toLowerCase() === r.title.toLowerCase(),
                          ),
                      ).map((r) => ({
                        id: r.id,
                        title: r.title,
                        artist: r.artist,
                        cover: albumCoverSrc(r),
                        genre: ALBUMS.find((a) => a.artist === r.artist)?.genre,
                      })),
                    ]}

                  />

                </div>

                <div className="mt-8 flex justify-center">
                  <a
                    href={SPOTIFY_PLAYLIST_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-3 border border-primary bg-primary px-8 py-4 font-mono text-sm font-bold uppercase tracking-[0.2em] text-white shadow-[0_0_40px_-5px_rgba(225,29,46,0.9)] transition-all duration-300 hover:scale-[1.02] hover:shadow-[0_0_60px_-5px_rgba(225,29,46,1)] sm:text-base"
                  >
                    Tune In on Spotify <ArrowUpRight size={18} className="transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </a>
                </div>

                <div className="mt-6 flex flex-wrap justify-center gap-3">
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#2563eb]/40 bg-white px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#2563eb]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb]" />
                    100% Full Playback
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#2563eb]/40 bg-white px-4 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-[#2563eb]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#2563eb]" />
                    Powered by Spotify
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

      </section>





      </main>


      {/* FOOTER */}
      <footer id="about" className="relative border-t border-white/10 bg-[#05070a] pb-36 text-slate-400 lg:pb-16">
        <div className="mx-auto max-w-7xl px-6 py-16 lg:py-20">
          {/* Brand + navigation */}
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.5fr_1fr_1fr]">
            {/* Brand */}
            <div>
              <a href="#top" aria-label="Hybrid AI Records — back to top" className={WORDMARK_LINK}>
                <BrandEagle
                  src={usaEmblem}
                  className="division-emblem h-28 w-auto sm:h-36"
                  decorative
                />
              </a>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Independent, SBA Veteran-Certified label. AI-powered distribution, video, and
                mastering — you keep every royalty and every master.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {[
                  { icon: Facebook, label: "Facebook", href: "https://www.facebook.com/people/Hybrid-AI-Records-LLC/61590094667469/" },
                  { icon: ThreadsIcon, label: "Threads", href: "https://www.threads.com/@hybridairecords" },
                  { icon: Youtube, label: "YouTube", href: YOUTUBE_CHANNEL_URL },
                  { icon: TikTokIcon, label: "TikTok", href: "https://www.tiktok.com/@spaulshaw4" },
                  { icon: Instagram, label: "Instagram", href: "https://www.instagram.com/hybridairecords" },
                  { icon: AudiomackIcon, label: "Audiomack", href: "https://audiomack.com/spaulshaw4" },
                  { icon: ShoppingBag, label: "Merch", href: "https://hybrid-ai-recordsl-llc.printful.me/" },
                ].map(({ icon: Icon, label, href }) => (
                  <a
                    key={label}
                    href={href}
                    target={href.startsWith("http") ? "_blank" : undefined}
                    rel={href.startsWith("http") ? "noreferrer" : undefined}
                    aria-label={label}
                    className="grid h-10 w-10 place-items-center rounded-full border border-white/10 bg-slate-900/80 text-slate-200 transition-colors hover:border-blue-500/50 hover:text-white"
                  >
                    <Icon size={16} />
                  </a>
                ))}
              </div>
            </div>

            {/* Platform */}
            <div>
              <div className="eyebrow">Platform</div>
              <ul className="mt-5 space-y-3">
                {[
                  { label: "Distribution & Video", href: "/portal", isLink: true },
                  { label: "Hybrid Engine 1.0", href: "/engine", isLink: true },
                  { label: "Artists", href: "#catalog", isLink: false },
                  { label: "Podcast", href: "#podcast", isLink: false },
                  { label: "Tokens", href: "/tokens", isLink: true },
                ].map(({ label, href, isLink }) => {
                  const className = "text-sm text-slate-400 transition-colors hover:text-white";
                  return isLink ? (
                    <li key={label}>
                      <Link to={href} className={className}>
                        {label}
                      </Link>
                    </li>
                  ) : (
                    <li key={label}>
                      <a href={href} className={className}>
                        {label}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Legal */}
            <div>
              <div className="eyebrow">Legal</div>
              <ul className="mt-5 space-y-3">
                <li>
                  <Link to="/privacy" className="text-sm text-slate-400 transition-colors hover:text-white">
                    Privacy
                  </Link>
                </li>
                <li>
                  <a
                    href="#terms"
                    onClick={(e) => {
                      e.preventDefault();
                      setTermsOpen(true);
                    }}
                    className="text-sm text-slate-400 transition-colors hover:text-white"
                  >
                    Terms
                  </a>
                </li>
                <li>
                  <Link to="/licensing" className="text-sm text-slate-400 transition-colors hover:text-white">
                    Licensing
                  </Link>
                </li>
                <li>
                  <a
                    href="#about"
                    onClick={(e) => {
                      e.preventDefault();
                      openAbout();
                    }}
                    className="text-sm text-slate-400 transition-colors hover:text-white"
                  >
                    About
                  </a>
                </li>
                <li>
                  <a
                    href="#contact"
                    onClick={(e) => {
                      e.preventDefault();
                      openContact();
                    }}
                    className="text-sm text-slate-400 transition-colors hover:text-white"
                  >
                    Contact
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <DivisionFooterBadge />

          <VerifiedBadges />

          <div className="mt-8 flex flex-col items-center gap-4">
            <BrandEagle
              src={usaEmblem}
              className="division-emblem h-24 w-auto sm:h-28"
              alt="Hybrid AI Records LLC"
            />
            <a
              href="/veteran-certification"
              aria-label="Officially Certified Veteran-Owned Small Business (SBA VetCert) — view the affidavit of veteran ownership (view-only page)"
              className="vetcert-badge inline-flex min-h-11 items-center justify-center gap-2.5 rounded-full bg-slate-900/90 px-6 py-3 text-center font-mono text-[11px] font-semibold uppercase tracking-wider text-amber-200 transition-all hover:border-amber-400 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#05070a]"
            >
              <ShieldCheck size={16} strokeWidth={2} aria-hidden className="vetcert-badge-icon shrink-0" />
              Officially Certified Veteran-Owned Small Business (SBA VetCert)
              <ArrowUpRight size={14} strokeWidth={2} aria-hidden className="vetcert-badge-icon shrink-0" />
            </a>
          </div>


          <div className="mt-12 flex flex-col gap-4 border-t border-white/10 pt-8 text-xs text-slate-100 md:flex-row md:items-center md:justify-between">
            <div className="font-mono uppercase tracking-[0.18em]">
              © 2026 Hybrid AI Records LLC · SBA Veteran-Certified · Knoxville, TN
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-3 font-mono uppercase tracking-[0.18em] md:justify-end">
              <Link to="/privacy" className="text-slate-100 transition-colors hover:text-white">
                Privacy
              </Link>
              <a
                href="#terms"
                onClick={(e) => {
                  e.preventDefault();
                  setTermsOpen(true);
                }}
                className="text-slate-100 transition-colors hover:text-white"
              >
                Terms
              </a>
              <Link to="/licensing" className="text-slate-100 transition-colors hover:text-white">
                Licensing
              </Link>
              <Link to="/engine" className="text-slate-100 transition-colors hover:text-white">
                Legal Notice
              </Link>
            </div>
          </div>
        </div>
      </footer>

      <VideoModal video={activeVideo} onClose={closeVideo} />

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <HowItWorksModal
        open={howItWorksOpen}
        onClose={() => setHowItWorksOpen(false)}
        onSubmit={() => {
          setHowItWorksOpen(false);
          navigate({ to: "/engine" });
        }}
      />
      <TermsModal open={termsOpen} onClose={() => setTermsOpen(false)} />
      
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />

      {payNow && (
        <PayNowModal
          open
          packageLabel={payNow.title}
          priceLabel={priceLabel(payNow.priceIdSingle, currency) ?? payNow.priceSingle}
          onClose={() => setPayNow(null)}
          onSubmitted={({ reference, email }) => startPaidOrder(payNow, reference, email)}
        />
      )}

      <ApplicationModal
        open={applyPackage !== null}
        onClose={() => setApplyPackage(null)}
        defaultPackage={applyPackage ?? "foundation_single"}
      />

      {checkoutOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Checkout"
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overlay-scrim bg-foreground/40 p-4 backdrop-blur-md sm:p-8"
          onClick={closeCheckout}
        >
          <div
            className="relative my-auto w-full max-w-3xl bg-white text-black shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeCheckout}
              className="absolute end-3 top-3 z-10 rounded-full studio-glass p-2 text-foreground transition hover:bg-white"
              aria-label="Close checkout"
            >
              <X size={18} />
            </button>
            {checkoutElement}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared keyword search input used by the pricing FAQ and revision policy panels. */
function HelpSearchInput({
  id,
  label,
  value,
  onChange,
  count,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  count: string;
}) {
  return (
    <div className="mb-5 max-w-md">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="relative">
        <Search
          size={15}
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          id={id}
          type="search"
          value={value}
          placeholder={label}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-border bg-white py-2 ps-9 pe-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
      </div>
      <p aria-live="polite" className="mt-1 text-[11px] text-muted-foreground">
        {count}
      </p>
    </div>
  );
}

/** Pricing FAQ list with keyword filtering across questions and answers. */
function PricingFaqSearchable() {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const items = term
    ? PRICING_FAQ.filter(
        (i) => i.q.toLowerCase().includes(term) || i.a.toLowerCase().includes(term),
      )
    : PRICING_FAQ;

  return (
    <>
      <HelpSearchInput
        id="faq-search"
        label="Search the pricing FAQ"
        value={q}
        onChange={setQ}
        count={`${items.length} of ${PRICING_FAQ.length} answers shown`}
      />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No answers match &ldquo;{q.trim()}&rdquo;. Try a shorter keyword, or use the WhatsApp button above.
        </p>
      ) : (
        <dl className="max-w-3xl space-y-4">
          {items.map((item) => (
            <div key={item.q}>
              <dt className="font-display text-sm font-bold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">{item.q}</dt>
              <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.a}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/** Revision policy blocks with keyword filtering across titles and rules. */
function RevisionPolicySearchable() {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const blocks = term
    ? REVISION_POLICY.map((b) => ({
        ...b,
        points: b.title.toLowerCase().includes(term)
          ? b.points
          : b.points.filter((p) => p.toLowerCase().includes(term)),
      })).filter((b) => b.points.length > 0)
    : REVISION_POLICY;

  const total = REVISION_POLICY.reduce((n, b) => n + b.points.length, 0);
  const shown = blocks.reduce((n, b) => n + b.points.length, 0);

  return (
    <>
      <HelpSearchInput
        id="revision-search"
        label="Search revision rules"
        value={q}
        onChange={setQ}
        count={`${shown} of ${total} rules shown`}
      />
      {blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rules match &ldquo;{q.trim()}&rdquo;. Try &ldquo;round&rdquo;, &ldquo;scope&rdquo;, or &ldquo;quote&rdquo;.
        </p>
      ) : (
        <div className="grid gap-6 md:grid-cols-3">
          {blocks.map((block) => (
            <div key={block.title}>
              <h4 className="font-display text-sm font-bold text-blue-400 drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)]">{block.title}</h4>
              <ul className="mt-3 space-y-2.5">
                {block.points.map((point) => (
                  <li key={point} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
                    <Check size={15} aria-hidden className="mt-0.5 shrink-0" style={{ color: block.color }} />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
