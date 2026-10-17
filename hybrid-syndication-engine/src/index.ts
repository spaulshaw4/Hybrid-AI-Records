import * as dotenv from "dotenv";
import { TrackPayload } from "./types";
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
  tokenPriceUsd: 1.00,
  lyrics: "The world we live in is the one we keep.",
  stemUrls: [
    {
      name: "Vocals",
      url: "https://hybrid-ai-records.com/audio/stems/the-world-we-live-in-vocals.wav",
    },
  ],
};

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
    result.jsonLd.track.offers.price === "1.00",
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

  console.log("\n==================================================");
  console.log("   SYNDICATION TEST COMPLETE: ALL LAYERS VALIDATED");
  console.log("==================================================");
}

runSyndicationAudit();
