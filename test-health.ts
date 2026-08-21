import { buildMiniMaxPayload } from "./src/lib/minimax-payload";

const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY; // Optional direct key

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);
const info = (m: string) => console.log(`  ℹ️  ${m}`);

async function runHealthCheck() {
  console.log("=== Audio Engine Health Check ===\n");

  // 1. Environment variables
  console.log("Environment");
  if (!LOVABLE_API_KEY) {
    bad("LOVABLE_API_KEY is missing");
  } else {
    ok("LOVABLE_API_KEY is set");
  }

  if (!REPLICATE_API_KEY) {
    bad("REPLICATE_API_KEY is missing");
  } else {
    ok("REPLICATE_API_KEY is set");
  }

  // 2. ElevenLabs Music via Replicate (through the Lovable connector gateway)
  console.log("\nElevenLabs Music via Replicate (Lovable gateway)");
  if (!LOVABLE_API_KEY || !REPLICATE_API_KEY) {
    info("Skipping gateway verification — credentials missing");
  } else {
    try {
      const response = await fetch(
        "https://connector-gateway.lovable.dev/api/v1/verify_credentials",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "X-Connection-Api-Key": REPLICATE_API_KEY,
          },
        },
      );
      const body = await response.text();
      if (response.ok && body.includes("verified")) {
        ok(`Gateway credentials verified (${response.status})`);
      } else {
        bad(`Gateway verification failed [${response.status}]: ${body.slice(0, 300)}`);
      }
    } catch (error: any) {
      bad(`Gateway verification error: ${error.message}`);
    }
  }

  // 3. MiniMax 2.6 payload structure using the project's payload builder
  console.log("\nMiniMax 2.6 Payload Structure");
  try {
    const payload = buildMiniMaxPayload({
      prompt: "Sung in native Lithuanian, correct local diacritics, alternative rock master audio",
      lyrics: "[Verse]\nHealth check test lyrics",
      language: "Lithuanian",
      instrumental: false,
      audioFormat: "mp3",
    });

    const expectedKeys = ["prompt", "is_instrumental", "lyrics_optimizer", "audio_format"];
    const inputKeys = Object.keys(payload.input);
    const missing = expectedKeys.filter((k) => !inputKeys.includes(k));

    if (missing.length > 0) {
      bad(`MiniMax payload missing keys: ${missing.join(", ")}`);
    } else {
      ok("MiniMax payload structure valid");
    }

    if (payload.settings.sample_rate !== 44100) {
      bad(`Expected sample_rate 44100, got ${payload.settings.sample_rate}`);
    } else {
      ok("MiniMax sample rate set to 44.1 kHz");
    }

    if (payload.settings.bitrate !== 256000) {
      bad(`Expected bitrate 256000, got ${payload.settings.bitrate}`);
    } else {
      ok("MiniMax bitrate set to 256 kbps");
    }

    if (payload.settings.timeout_seconds !== 240) {
      bad(`Expected timeout 240s, got ${payload.settings.timeout_seconds}`);
    } else {
      ok("MiniMax timeout set to 240s");
    }

    info("Payload preview:");
    console.log(JSON.stringify(payload, null, 2));
  } catch (error: any) {
    bad(`MiniMax payload build failed: ${error.message}`);
  }

  if (MINIMAX_API_KEY) {
    info("MINIMAX_API_KEY is set (direct API dispatch available when wired).");
  } else {
    info("MINIMAX_API_KEY is not set — the project routes MiniMax through the Replicate gateway.");
  }

  console.log("\n=== Health Check Complete ===");
}

runHealthCheck().catch((error) => {
  console.error("Health check crashed:", error);
  process.exit(1);
});
