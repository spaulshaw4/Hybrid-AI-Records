/**
 * Shared Open Graph / Twitter Card metadata for every route.
 *
 * Social crawlers need absolute URLs and a self-referencing og:url, so each
 * page builds its tags from its own path through `pageHead()` instead of
 * inheriting a single sitewide preview.
 */
import socialBanner from "@/assets/social-banner-wide.jpg.asset.json";
import banner1200 from "@/assets/social-banner-1200x630.jpg.asset.json";
import banner1080 from "@/assets/social-banner-1080x1080.jpg.asset.json";
import banner1920 from "@/assets/social-banner-1920x1080.jpg.asset.json";
import bannerStory from "@/assets/social-banner-1080x1920.jpg.asset.json";
import bannerSquareVector from "@/assets/social-banner-vector-1080x1080.jpg.asset.json";
import bannerPng1200 from "@/assets/social-banner-1200x630.png.asset.json";
import bannerPngSquare from "@/assets/social-banner-1080x1080.png.asset.json";
import bannerPngStory from "@/assets/social-banner-1080x1920.png.asset.json";

export const SITE_ORIGIN = "https://hybrid-ai-records.com";
export const SITE_NAME = "Hybrid AI Records";

/** Turns a site-relative asset path or path fragment into an absolute URL. */
export const absoluteUrl = (path: string) =>
  path.startsWith("http") ? path : `${SITE_ORIGIN}${path.startsWith("/") ? "" : "/"}${path}`;

/**
 * Share-image variants. `wide` (1.91:1) is the Open Graph / Twitter large-card
 * default, `hd` is the 16:9 cut some players and messaging apps prefer,
 * `square` backs `summary` cards and platforms that centre-crop (Slack,
 * WhatsApp, Pinterest), and `story` is the 9:16 frame for Reels / Stories /
 * Shorts / TikTok. `story` and `squareVector` are rendered from the committed
 * SVG source, so they stay sharp at any resolution.
 */
export const SHARE_IMAGES = {
  wide: { url: banner1200.url, width: "1200", height: "630" },
  hd: { url: banner1920.url, width: "1920", height: "1080" },
  square: { url: banner1080.url, width: "1080", height: "1080" },
  /** 9:16 story/reel frame, rendered from the vector source. */
  story: { url: bannerStory.url, width: "1080", height: "1920" },
  /** 1:1 rendered from the vector source (matches the story frame's layout). */
  squareVector: { url: bannerSquareVector.url, width: "1080", height: "1080" },
  /** Max-resolution master (2400x1260) for platforms that upscale poorly. */
  master: { url: socialBanner.url, width: "2400", height: "1260" },
} as const;


/** Lossless PNG cuts of the same frames (print, decks, platforms that reject JPEG). */
export const SHARE_IMAGES_PNG = {
  wide: { url: bannerPng1200.url, width: "1200", height: "630" },
  square: { url: bannerPngSquare.url, width: "1080", height: "1080" },
  story: { url: bannerPngStory.url, width: "1080", height: "1920" },
} as const;

export type ShareImageVariant = keyof typeof SHARE_IMAGES;

/** Default share image: the 1200x630 banner (universally supported box). */
export const DEFAULT_OG_IMAGE = absoluteUrl(SHARE_IMAGES.wide.url);

/** Declared share-image box — forces the large card layout on every platform. */
export const OG_IMAGE_WIDTH = SHARE_IMAGES.wide.width;
export const OG_IMAGE_HEIGHT = SHARE_IMAGES.wide.height;

export type PageHeadOptions = {
  /** Route path, e.g. "/portal" or "/" — used for og:url and canonical. */
  path: string;
  title: string;
  description: string;
  /** Short social variant; falls back to `title`. */
  socialTitle?: string;
  /** Short social variant; falls back to `description`. */
  socialDescription?: string;
  /** Absolute or site-relative image. Pass `null` to omit image tags. */
  image?: string | null;
  /**
   * Which generated banner to share when `image` isn't overridden.
   * Defaults to `wide` (1200x630), or `square` (1080x1080) on `summary` cards.
   */
  imageVariant?: ShareImageVariant;
  imageAlt?: string;
  type?: "website" | "article" | "profile" | "music.song";
  card?: "summary" | "summary_large_image";
  /** Private/utility pages: emits robots noindex and skips the canonical. */
  noindex?: boolean;
};

/** Builds the `head()` return value (meta + canonical link) for a route. */
export function pageHead(options: PageHeadOptions) {
  const {
    path,
    title,
    description,
    socialTitle = title,
    socialDescription = description,
    image,
    imageVariant,
    imageAlt = SITE_NAME,
    type = "website",
    card = "summary_large_image",
    noindex = false,
  } = options;

  const url = absoluteUrl(path);

  // Pick the banner whose aspect ratio matches the card the page requests, so
  // declared og:image:width/height always describe the file actually served.
  const variant = SHARE_IMAGES[imageVariant ?? (card === "summary" ? "square" : "wide")];
  const resolvedImage =
    image === null ? null : absoluteUrl(image ?? variant.url);
  const imageWidth = image ? OG_IMAGE_WIDTH : variant.width;
  const imageHeight = image ? OG_IMAGE_HEIGHT : variant.height;

  const meta: Array<Record<string, string>> = [
    { title },
    { name: "description", content: description },

    { property: "og:site_name", content: SITE_NAME },
    { property: "og:type", content: type },
    { property: "og:url", content: url },
    { property: "og:title", content: socialTitle },
    { property: "og:description", content: socialDescription },
    { property: "og:locale", content: "en_US" },

    { name: "twitter:card", content: resolvedImage ? card : "summary" },
    { name: "twitter:title", content: socialTitle },
    { name: "twitter:description", content: socialDescription },
  ];

  if (resolvedImage) {
    meta.push(
      { property: "og:image", content: resolvedImage },
      { property: "og:image:secure_url", content: resolvedImage },
      { property: "og:image:type", content: "image/jpeg" },
      // Explicit dimensions make crawlers render the large banner layout
      // immediately, without waiting to fetch and measure the file.
      { property: "og:image:width", content: imageWidth },
      { property: "og:image:height", content: imageHeight },
      { property: "og:image:alt", content: imageAlt },
      { name: "twitter:image", content: resolvedImage },
      { name: "twitter:image:alt", content: imageAlt },
    );
  }



  if (noindex) meta.push({ name: "robots", content: "noindex, nofollow" });

  return {
    meta,
    // Canonical only on indexable pages: noindex utility routes shouldn't
    // advertise themselves as the canonical version of anything.
    links: noindex ? [] : [{ rel: "canonical", href: url }],
  };
}
