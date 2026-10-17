import * as dotenv from "dotenv";
import { TrackPayload } from "./types";
import { submitToIndexNow } from "./layer1-indexing/indexnow";
import { notifyWebSubHub } from "./layer1-indexing/websub";
import { generateTrackJsonLd } from "./layer2-metadata/jsonld";
import { generateOpenGraphTags } from "./layer2-metadata/opengraph";
import { buildMRSSFeed } from "./layer3-feeds/mrss-builder";

dotenv.config();

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
};

async function runSyndicationAudit() {
  console.log("==================================================");
  console.log("   HYBRID SYNDICATION ENGINE — LOCAL PIPELINE TEST");
  console.log("==================================================\n");

  const canonicalUrl = `${process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com"}/portal?tab=catalog&track=${testRelease.id}`;
  const feedUrl = `${process.env.PORTAL_BASE_URL || "https://hybrid-ai-records.com"}/api/feed/mrss.xml`;

  // --- LAYER 2: Semantic Metadata Verification ---
  console.log("▶ [LAYER 2] Generating Semantic JSON-LD...");
  const jsonLd = generateTrackJsonLd(testRelease, canonicalUrl);
  console.log(JSON.stringify(jsonLd, null, 2));

  console.log("\n▶ [LAYER 2] Generating Dynamic OpenGraph Tags...");
  const ogTags = generateOpenGraphTags(testRelease, canonicalUrl);
  console.log(ogTags);

  // --- LAYER 3: MRSS XML Build Verification ---
  console.log("\n▶ [LAYER 3] Building Media RSS (MRSS) XML Feed...");
  const mrssXml = buildMRSSFeed([testRelease]);
  console.log(mrssXml.substring(0, 450) + "\n... [truncated for display]");

  // --- LAYER 1: Search Dispatching Simulation ---
  console.log("\n▶ [LAYER 1] Simulating IndexNow & WebSub Broadcasting...");
  await submitToIndexNow([canonicalUrl]);
  await notifyWebSubHub(feedUrl);

  console.log("\n==================================================");
  console.log("   SYNDICATION TEST COMPLETE: ALL LAYERS VALIDATED");
  console.log("==================================================");
}

runSyndicationAudit();
