import * as dotenv from "dotenv";
import { TrackPayload } from "./types";
import { submitToIndexNow } from "./layer1-indexing/indexnow";
import { syndicateRelease } from "./syndicate";

dotenv.config();

const expectedUrls = {
  album: "https://hybrid-ai-records.com/catalog/heavy-sky-arrival",
  track: "https://hybrid-ai-records.com/track/the-world-we-live-in",
  lyrics: "https://hybrid-ai-records.com/track/the-world-we-live-in/lyrics",
  stems: "https://hybrid-ai-records.com/track/the-world-we-live-in/stems",
};

// Mock Release Payload
const testRelease: TrackPayload = {
  id: "track-hsk-001",
  isrc: "US-HYB-26-00001",
  title: "The World We Live In",
  artistName: "Stephen P. Shaw",
  albumName: "Heavy Sky Arrival",
  genre: "Symphonic Rock",
  releaseDate: "2026-09-01",
  durationSeconds: 255,
  previewAudioUrl: "https://hybrid-ai-records.com/audio/previews/the-world-we-live-in-preview.mp3",
  masterAudioUrl: "https://hybrid-ai-records.com/audio/masters/the-world-we-live-in-24bit.wav",
  coverArtUrl: "https://hybrid-ai-records.com/brand/lockup-usa-512.png",
  explicit: false,
  tokenPriceUsd: 2.00,
  lyrics: "The world we live in is the one we keep.",
  stemUrls: [
    {
      name: "Vocals",
      url: "https://hybrid-ai-records.com/audio/stems/the-world-we-live-in-vocals.wav",
    },
  ],
};

const livePortalUrls = [
  "https://hybrid-ai-records.com/",
  "https://hybrid-ai-records.com/portal?tab=create",
  "https://hybrid-ai-records.com/portal?tab=catalog",
  "https://hybrid-ai-records.com/portal?tab=plans",
  "https://hybrid-ai-records.com/portal?tab=radio",
  "https://hybrid-ai-records.com/portal?tab=distro",
  "https://hybrid-ai-records.com/api/feed/mrss.xml",
];

function isUnshippedSlugUrl(url: string): boolean {
  const path = new URL(url).pathname;
  return path.startsWith("/catalog/") || path.startsWith("/track/");
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`ASSERT FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`ASSERT PASS: ${message}`);
}

async function runSyndicationAudit() {
  console.log("==================================================");
  console.log("   HYBRID SYNDICATION ENGINE — LOCAL PIPELINE TEST");
  console.log("==================================================\n");

  const result = await syndicateRelease(testRelease);

  console.log("\n▶ URLs");
  console.log(JSON.stringify(result.urls, null, 2));

  console.log("\n▶ Album JSON-LD");
  console.log(JSON.stringify(result.jsonLd.album, null, 2));

  console.log("\n▶ Track JSON-LD");
  console.log(JSON.stringify(result.jsonLd.track, null, 2));

  console.log("\n▶ Lyrics JSON-LD");
  console.log(JSON.stringify(result.jsonLd.lyrics, null, 2));

  console.log("\n▶ Stems JSON-LD");
  console.log(JSON.stringify(result.jsonLd.stems, null, 2));

  console.log("\n▶ OpenGraph");
  console.log(result.openGraph);

  console.log("\n▶ MRSS");
  console.log(result.mrss.substring(0, 450) + "\n... [truncated for display]");

  console.log("\n▶ Radio directory");
  console.log(JSON.stringify(result.radio, null, 2));

  console.log("\n▶ Shortform clip request");
  console.log(JSON.stringify(result.clip, null, 2));

  assert(result.urls.album === expectedUrls.album, `album URL ${result.urls.album}`);
  assert(result.urls.track === expectedUrls.track, `track URL ${result.urls.track}`);
  assert(result.urls.lyrics === expectedUrls.lyrics, `lyrics URL ${result.urls.lyrics}`);
  assert(result.urls.stems === expectedUrls.stems, `stems URL ${result.urls.stems}`);
  assert(
    result.jsonLd.track.duration === "PT4M15S",
    `track JSON-LD duration ${result.jsonLd.track.duration}`,
  );
  assert(
    result.jsonLd.track.offers.price === "2.00",
    `track JSON-LD price ${result.jsonLd.track.offers.price}`,
  );
  assert(
    result.mrss.includes(`<link>${expectedUrls.track}</link>`),
    `MRSS link ${expectedUrls.track}`,
  );
  assert(result.clip.aspect === "9:16", `clip aspect ${result.clip.aspect}`);
  assert(
    result.clip.durationSeconds >= 15 && result.clip.durationSeconds <= 30,
    `clip duration ${result.clip.durationSeconds}`,
  );
  assert(
    livePortalUrls.length === 7 && livePortalUrls.every((url) => !isUnshippedSlugUrl(url)),
    "IndexNow list is live portal URLs only",
  );

  console.log("\n▶ [LAYER 1] IndexNow live portal URLs");
  const indexNow = await submitToIndexNow(livePortalUrls);
  if (indexNow.status === null) {
    console.error("[IndexNow] No HTTP response. This run did not succeed.");
  } else if (!indexNow.ok) {
    console.error(`[IndexNow] Not successful. HTTP ${indexNow.status}`);
  }

  console.log("\n==================================================");
  if (indexNow.ok) {
    console.log("   SYNDICATION TEST COMPLETE: ALL LAYERS VALIDATED");
  } else {
    console.log("   LOCAL ASSERTS PASSED");
    console.log(`   INDEXNOW NOT ACCEPTED: HTTP ${indexNow.status ?? "none"}`);
  }
  console.log("==================================================");
}

runSyndicationAudit();
