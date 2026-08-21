import { DEFAULT_DIVISION_NAMES } from "@/lib/division-settings";
import { resolveDivision, type Division } from "@/lib/divisions";

export const SITE_URL = "https://hybrid-ai-records.com";
export const LABEL_NAME = "Hybrid AI Records LLC";
export const LABEL_ID = `${SITE_URL}/#organization`;

export type SchemaRelease = {
  id: string;
  title: string;
  artist: string;
  year: string;
  cover?: string;
  division?: Division;
};

const absolute = (url: string) => (url.startsWith("http") ? url : `${SITE_URL}${url.startsWith("/") ? "" : "/"}${url}`);

/** Cover art for a release: explicit artwork, else the YouTube thumbnail. */
export const releaseImage = (r: SchemaRelease) =>
  r.cover ? absolute(r.cover) : `https://i.ytimg.com/vi/${r.id}/maxresdefault.jpg`;

/** Canonical-ish anchor for a release within the catalog. */
export const releaseUrl = (r: SchemaRelease) => `${SITE_URL}/#release-${r.id}`;

/** Split "A feat. B & C" credits into individual performers. */
export const performersOf = (artist: string): string[] =>
  artist
    .split(/\s*(?:feat\.|featuring|&|,|—|-{1,2}\s)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);

/** The imprint/division a release is published under, as an Organization node. */
export function divisionNode(r: SchemaRelease, names = DEFAULT_DIVISION_NAMES) {
  const division = resolveDivision(r);
  return {
    "@type": "Organization",
    "@id": `${SITE_URL}/#division-${division}`,
    name: names[division],
    parentOrganization: { "@id": LABEL_ID },
  };
}

/** Schema.org MusicRecording for a single release. */
export function releaseNode(r: SchemaRelease, names = DEFAULT_DIVISION_NAMES) {
  return {
    "@type": "MusicRecording",
    "@id": releaseUrl(r),
    name: r.title,
    url: releaseUrl(r),
    image: releaseImage(r),
    datePublished: r.year,
    inLanguage: "en",
    byArtist: performersOf(r.artist).map((name) => ({ "@type": "MusicGroup", name })),
    recordLabel: divisionNode(r, names),
    publisher: { "@id": LABEL_ID },
    copyrightHolder: { "@id": LABEL_ID },
    audio: { "@type": "AudioObject", contentUrl: `https://www.youtube.com/watch?v=${r.id}` },
    sameAs: `https://www.youtube.com/watch?v=${r.id}`,
  };
}

export const PODCAST_ID = `${SITE_URL}/#podcast`;
export const PODCAST_NAME = "Hybrid AI Records LLC Podcast";

/** Public profiles the label controls, used for Organization sameAs. */
export const LABEL_SAME_AS = [
  "https://www.youtube.com/@HybridAIRecords",
  "https://www.youtube.com/@HybridAIRecordsPodcast",
  "https://www.facebook.com/people/Hybrid-AI-Records-LLC/61590094667469/",
  "https://www.instagram.com/hybridairecords",
  "https://www.tiktok.com/@spaulshaw4",
  "https://open.spotify.com/playlist/7hc4GrFq9A9l1e0Xve39r8",
];

/** Organization node for the label itself. */
export function labelNode(divisions: Division[] = ["jester", "lithuania", "nigeria", "usa"], names = DEFAULT_DIVISION_NAMES) {
  return {
    "@type": ["Organization", "MusicGroup"],
    "@id": LABEL_ID,
    name: LABEL_NAME,
    alternateName: "Hybrid AI Records",
    url: `${SITE_URL}/`,
    logo: {
      "@type": "ImageObject",
      "@id": `${SITE_URL}/#logo`,
      url: `${SITE_URL}/favicon.jpg`,
      caption: LABEL_NAME,
    },
    image: `${SITE_URL}/favicon.jpg`,
    slogan: "Raw Words. Real Music. Global Impact.",
    foundingDate: "2025",
    founder: { "@type": "Person", name: "Steven P. Shaw" },
    knowsAbout: ["Music production", "Mixing and mastering", "Music distribution", "Music video production"],
    sameAs: LABEL_SAME_AS,
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        url: `${SITE_URL}/#contact`,
        availableLanguage: ["English"],
      },
    ],
    description:
      "SBA Veteran-Certified independent record label producing release-ready music, official videos, and podcast content with 100% artist ownership.",
    subOrganization: divisions.map((d) => ({
      "@type": "Organization",
      "@id": `${SITE_URL}/#division-${d}`,
      name: names[d],
      parentOrganization: { "@id": LABEL_ID },
    })),
  };
}

export type SchemaEpisode = { id: string; title: string; date?: string };

/** PodcastSeries + PodcastEpisode graph nodes for the homepage podcast section. */
export function podcastNodes(episodes: SchemaEpisode[], imageUrl?: string) {
  const episodeNodes = episodes.map((ep, i) => ({
    "@type": "PodcastEpisode",
    "@id": `${SITE_URL}/#episode-${ep.id}`,
    name: ep.title,
    url: `https://www.youtube.com/watch?v=${ep.id}`,
    episodeNumber: i + 1,
    ...(ep.date ? { datePublished: ep.date } : {}),
    image: `https://i.ytimg.com/vi/${ep.id}/maxresdefault.jpg`,
    inLanguage: "en",
    partOfSeries: { "@id": PODCAST_ID },
    associatedMedia: {
      "@type": "VideoObject",
      name: ep.title,
      thumbnailUrl: `https://i.ytimg.com/vi/${ep.id}/maxresdefault.jpg`,
      contentUrl: `https://www.youtube.com/watch?v=${ep.id}`,
      embedUrl: `https://www.youtube.com/embed/${ep.id}`,
      ...(ep.date ? { uploadDate: ep.date } : {}),
    },
    publisher: { "@id": LABEL_ID },
  }));

  const series = {
    "@type": "PodcastSeries",
    "@id": PODCAST_ID,
    name: PODCAST_NAME,
    url: `${SITE_URL}/#podcast`,
    description:
      "The Hybrid AI Records podcast — label updates, artist conversations, and the Tuesday Update series from an SBA Veteran-Certified independent label.",
    inLanguage: "en",
    webFeed: "https://www.youtube.com/@HybridAIRecordsPodcast",
    ...(imageUrl ? { image: absolute(imageUrl) } : {}),
    author: { "@id": LABEL_ID },
    publisher: { "@id": LABEL_ID },
    numberOfEpisodes: episodeNodes.length,
    sameAs: ["https://www.youtube.com/@HybridAIRecordsPodcast"],
  };

  return [series, ...episodeNodes];
}

/** Standalone @graph for the Organization + podcast, injected on the homepage. */
export function buildOrganizationPodcastJsonLd(
  episodes: SchemaEpisode[],
  imageUrl?: string,
  names = DEFAULT_DIVISION_NAMES,
) {
  return {
    "@context": "https://schema.org",
    "@graph": [
      labelNode(undefined, names),
      websiteNode(),

      ...podcastNodes(episodes, imageUrl),
    ],
  };
}

/**
 * Full @graph for the catalog: the label, its divisions, an ItemList of
 * releases, and one MusicRecording node per release.
 */
export function buildCatalogJsonLd(releases: SchemaRelease[], names = DEFAULT_DIVISION_NAMES) {
  const recordings = releases.map((r) => releaseNode(r, names));
  return {
    "@context": "https://schema.org",
    "@graph": [
      // The full Organization node ships in buildOrganizationPodcastJsonLd;
      // reference it by @id here so the two graphs don't duplicate it.
      { "@id": LABEL_ID },
      {
        "@type": "ItemList",
        "@id": `${SITE_URL}/#catalog`,
        name: `${LABEL_NAME} Catalog`,
        numberOfItems: recordings.length,
        itemListElement: recordings.map((rec, i) => ({
          "@type": "ListItem",
          position: i + 1,
          url: rec.url,
          item: { "@id": rec["@id"] },
        })),
      },
      // Radio / catalog playlist: ties every recording into one MusicPlaylist
      // entity so search engines can surface the label's streaming rotation.
      {
        "@type": "MusicPlaylist",
        "@id": `${SITE_URL}/#radio-playlist`,
        name: "Hybrid AI Radio",
        url: `${SITE_URL}/#radio`,
        description:
          "Continuous rotation of Hybrid AI Records releases across every division.",
        numTracks: recordings.length,
        author: { "@id": LABEL_ID },
        track: recordings.map((rec) => ({ "@id": rec["@id"] })),
      },
      ...recordings,
    ],
  };
}

/** WebSite node for the label domain. */
export function websiteNode() {
  return {
    "@type": "WebSite",
    "@id": `${SITE_URL}/#website`,
    url: `${SITE_URL}/`,
    name: LABEL_NAME,
    alternateName: "Hybrid AI Records",
    publisher: { "@id": LABEL_ID },
    inLanguage: "en",
  };
}

export type Crumb = { name: string; path: string };

/** BreadcrumbList for a secondary page, always rooted at the homepage. */
export function breadcrumbNode(trail: Crumb[], pageId: string) {
  const items = [{ name: "Home", path: "/" }, ...trail];
  return {
    "@type": "BreadcrumbList",
    "@id": `${pageId}-breadcrumb`,
    itemListElement: items.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${SITE_URL}${c.path === "/" ? "/" : c.path}`,
    })),
  };
}

/**
 * Reusable @graph for a secondary page: the label Organization, the WebSite,
 * the page itself, and its breadcrumb trail. Keeps every route connected to
 * the same entity IDs instead of emitting orphan nodes.
 */
export function buildPageJsonLd(options: {
  path: string;
  name: string;
  description: string;
  breadcrumb?: Crumb[];
  extra?: Array<Record<string, unknown>>;
  /** Include the full Organization node (omit when the page already has one). */
  includeOrganization?: boolean;
}) {
  const { path, name, description, breadcrumb, extra = [], includeOrganization = true } = options;
  const pageId = `${SITE_URL}${path}#webpage`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      includeOrganization ? labelNode() : { "@id": LABEL_ID },
      websiteNode(),
      {
        "@type": "WebPage",
        "@id": pageId,
        url: `${SITE_URL}${path}`,
        name,
        description,
        inLanguage: "en",
        isPartOf: { "@id": `${SITE_URL}/#website` },
        publisher: { "@id": LABEL_ID },
        about: { "@id": LABEL_ID },
        ...(breadcrumb ? { breadcrumb: { "@id": `${pageId}-breadcrumb` } } : {}),
      },
      ...(breadcrumb ? [breadcrumbNode(breadcrumb, pageId)] : []),
      ...extra,
    ],
  };
}

