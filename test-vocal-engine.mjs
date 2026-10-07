/**
 * $0.01 Mureka reference ingest, then one generate-song.
 * Does not call mureka-ai/vocal-clone and does not send vocal_id.
 */
import { writeSync } from "node:fs";

const AUDIO_URL =
  "https://d2h7xmz5gqybh9.cloudfront.net/media/0a3b60ccd86a48bca1675e034b3d0057/audios/1791233733729564433_HdpzIRZa.mp3";
const FORBIDDEN_MASTER =
  "https://d2h7xmz5gqybh9.cloudfront.net/output/75d9c328-5c7c-41fb-8b38-2ff49527a334.wav";
const PROMPT = "Acoustic, heavy rock, driving live drums, raw gritty male vocal delivery, 86 BPM";
const LYRICS = "[Verse]\nWe own the night\n[Chorus]\nRaw words real music";
const DEADLINE = Date.now() + 8 * 60 * 1000;

function log(line) {
  writeSync(1, `${line}\n`);
}

function redact(value) {
  const key = process.env.WAVESPEED_API_KEY || "";
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (key) text = text.split(key).join("[REDACTED]");
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerAudioReference(audioUrl) {
  const res = await fetch("https://api.wavespeed.ai/api/v3/mureka-ai/create-upload-id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio: audioUrl,
      purpose: "reference",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Reference ingest error: ${redact(JSON.stringify(data))}`);
  return data.data.id;
}

function pickReferenceId(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("http://") || trimmed.startsWith("https://")) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return pickReferenceId(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = pickReferenceId(item);
      if (id) return id;
    }
    return "";
  }
  if (typeof value === "object") {
    return (
      pickReferenceId(value.reference_id) ||
      pickReferenceId(value.id) ||
      pickReferenceId(value.audio_id) ||
      ""
    );
  }
  return "";
}

function masterUrlFrom(outputs) {
  const items = Array.isArray(outputs) ? outputs : [outputs];
  for (const item of items) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (item && typeof item === "object") {
      const nested = item.url || item.audio || item.wav || item.output;
      if (typeof nested === "string" && /^https?:\/\//.test(nested)) return nested;
    }
  }
  return "";
}

async function pollPrediction(id) {
  const terminal = new Set(["completed", "failed", "cancelled", "timeout", "deleted"]);
  while (Date.now() < DEADLINE) {
    const res = await fetch(`https://api.wavespeed.ai/api/v3/predictions/${id}/result`, {
      headers: { Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}` },
    });
    const body = await res.json();
    const data = body?.data ?? body;
    const status = data?.status || "unknown";
    log(`prediction ${id} status=${status}`);
    if (!res.ok || terminal.has(status)) return data;
    await sleep(3000);
  }
  throw new Error(`Timed out after 8 minutes waiting for ${id}`);
}

async function generateSong(referenceId) {
  const res = await fetch("https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WAVESPEED_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: PROMPT,
      lyrics: LYRICS,
      output_format: "wav",
      reference_id: referenceId,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`generate-song error: ${redact(JSON.stringify(data))}`);
  return data.data.id;
}

if (!process.env.WAVESPEED_API_KEY) {
  log("WAVESPEED_API_KEY missing");
  process.exit(1);
}
if (AUDIO_URL === FORBIDDEN_MASTER || AUDIO_URL.includes("75d9c328-5c7c-41fb-8b38-2ff49527a334")) {
  log("refusing generated master as the reference");
  process.exit(1);
}

log("vocal_clone_submitted=false");
log(`audio_url=${AUDIO_URL}`);

try {
  const referencePredictionId = await registerAudioReference(AUDIO_URL);
  log(`reference_prediction_id=${referencePredictionId}`);
  const referenceResult = await pollPrediction(referencePredictionId);
  log(`reference_status=${referenceResult?.status || "unknown"}`);
  if (referenceResult?.error) log(`reference_error=${redact(referenceResult.error)}`);
  if (referenceResult?.status !== "completed") {
    log(`final_status=${referenceResult?.status || "unknown"}`);
    process.exit(1);
  }
  const referenceId = pickReferenceId(referenceResult.outputs);
  log(`reference_id=${referenceId || "(missing)"}`);
  if (!referenceId) {
    log(`reference_outputs=${redact(referenceResult.outputs)}`);
    log("final_status=completed_without_reference_id");
    process.exit(1);
  }

  const songPredictionId = await generateSong(referenceId);
  log(`song_prediction_id=${songPredictionId}`);
  const songResult = await pollPrediction(songPredictionId);
  const status = songResult?.status || "unknown";
  log(`final_status=${status}`);
  if (songResult?.error) log(`song_error=${redact(songResult.error)}`);
  const masterUrl = masterUrlFrom(songResult?.outputs);
  if (masterUrl) log(`master_url=${masterUrl}`);
  if (status !== "completed") process.exit(1);
} catch (err) {
  log(`final_status=error`);
  log(redact(err?.stack || err?.message || err));
  process.exit(1);
}
