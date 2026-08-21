/** The label packages — shared by the homepage and the /start page. */
export type ServicePackage = {
  n: string;
  slug: string;
  title: string;
  tagline: string;
  priceSingle: string;
  priceIdSingle: string;
  applySingle: string;
  color: string;
  accent: string;
  bring: string;
  do: string;
  get: string;
  /** Outcome-focused headline shown on the homepage service card. */
  outcome: string;
  /** Short action-oriented highlights shown under the outcome headline. */
  highlights: string[];
  /** How the package runs, start to delivery. */
  workflow?: string;
  /** Optional label-release path offered with this package. */
  labelOption?: string;
  /** "audio" pipelines sell per track / 10-track bundles; "video" is a flat per-video package; "distribution" is a flat per-track release. */
  kind?: "audio" | "video" | "distribution";
  /** When the final footage lands, counted from the shoot date. */
  deliveryEstimate?: string;
  /** The two ways an artist can kick this pipeline off — they pick one. */
  startOptions?: { icon: string; title: string; body: string }[];
  /** Plain-language distribution answer for this package. */
  distribution?: string;
  /** Prominent badge / tagline pill for the portal card. */
  badge?: string;
  /** Full feature list rendered with checkmarks on the portal card. */
  features?: string[];
  /** Delivery requirements accordion content for distribution packages. */
  deliveryRequirements?: {
    audioFormat: string;
    coverArt: string;
  };
};


export const SERVICES: ServicePackage[] = [
  {
    n: "D1",
    slug: "foundation",
    title: "Enterprise Distribution & Spotlight",
    tagline: "Global reach. Zero royalties taken. Dedicated platform real estate.",
    priceSingle: "$50 / Track",
    priceIdSingle: "foundation_song_onetime",
    applySingle: "foundation_single",
    color: "#e11d2e",
    accent: "bg-[#e11d2e]",
    kind: "distribution",
    badge: "100% Master Ownership",
    bring: "Your already-finished, release-ready masters and completed artwork.",
    do: "We distribute your tracks to 450+ DSPs across 200+ territories and spotlight your artist page.",
    get: "You retain 100% of your earnings and ownership with automated ISRC/UPC generation.",
    outcome: "Global distribution with front-page spotlight placement and 100% royalty retention.",
    highlights: [
      "Distribution to 450+ DSPs across 200+ territories.",
      "Front-page spotlight & dedicated artist page.",
      "Keep 100% of your royalties — zero hidden fees.",
    ],
    features: [
      "Global Reach: Distribution to 450+ DSPs across 200+ territories (Spotify, Apple Music, TikTok, Amazon Music, YouTube, Meta, Tidal, and more).",
      "Front-Page Spotlight & Dedicated Artist Page: Featured direct platform placement for real listener discovery.",
      "Keep 100% of Your Royalties: Zero backend distributor take-rate or hidden fees.",
      "Free Codes & Registration: Automated ISRC and UPC barcode generation included.",
      "Social & Video Monetization: Auto-delivery to YouTube Content ID & Meta Rights Manager.",
      "Direct-to-Artist Payouts: Full compatibility with fan tokens and instant album sales.",
    ],
    deliveryRequirements: {
      audioFormat:
        "16-bit or 24-bit uncompressed WAV or FLAC (44.1 kHz or higher).",
      coverArt:
        "Exact square, 3000 x 3000 px to 5000 x 5000 px (RGB mode, JPEG/PNG, no social handles or external web URLs).",
    },

    workflow:
      "Upload your finished masters and artwork. We run a technical delivery check for format and loudness compliance, then submit your release to every major store and streaming platform.",
    labelOption:
      "Artists can optionally choose to release and distribute their track directly under the Hybrid AI Records brand umbrella, plugging right into our established label network and release pipeline.",
  },
];


/** Flat-rate music video packages — sold per video, no 10-track bundle. */
export const VIDEO_SERVICES: ServicePackage[] = [
  {
    n: "V1",
    slug: "standard-video",
    title: "Standard Video Package",
    tagline: "HD Music Video · One-Shoot Deal · 0 Revisions",
    priceSingle: "$350 / video",
    priceIdSingle: "standard_video_onetime",
    applySingle: "standard_video_single",
    color: "#ffffff",
    accent: "bg-white",
    kind: "video",
    bring: "Your finished master and a short creative direction.",
    do: "We produce one official HD music video cut to your track.",
    get: "Final HD video file, delivery-ready for YouTube and socials — delivery is final.",
    outcome:
      "One official HD music video, built around your finished track. One-shoot deal — 0 revisions, delivery is final.",
    highlights: [
      "Full HD (1080p) delivery.",
      "One-shoot deal — 0 revisions, no returns, delivery is final.",
      "Platform-ready export for YouTube & socials.",
    ],
    deliveryEstimate: "Final footage delivered 10–14 business days after the shoot.",
  },
  {
    n: "V2",
    slug: "4k-hd-video",
    title: "4K HD Video Package",
    tagline: "4K Music Video · One-Shoot Deal · 0 Revisions",
    priceSingle: "$400 / video",
    priceIdSingle: "video_4k_onetime",
    applySingle: "video_4k_single",
    color: "#4b8bff",
    accent: "bg-[#4b8bff]",
    kind: "video",
    bring: "Your finished master and creative references.",
    do: "We produce one official 4K music video with an extended grade pass.",
    get: "Final 4K master file plus a compressed social cut — delivery is final.",
    outcome:
      "One official 4K music video with a cinematic colour grade. One-shoot deal — 0 revisions, delivery is final.",
    highlights: [
      "Ultra HD (4K) delivery.",
      "One-shoot deal — 0 revisions, no returns, delivery is final.",
      "Cinematic colour grade + social cut-down.",
    ],
    deliveryEstimate:
      "Final 4K footage delivered 14–21 business days after the shoot (grade pass included).",
  },
];
