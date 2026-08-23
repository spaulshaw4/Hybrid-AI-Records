import { createFileRoute } from "@tanstack/react-router";
import { newCorrelationId } from "@/lib/apiframe.server";
import { RATE_LIMITS, limitBy } from "@/lib/rate-limit";
import { studioUserIdFromRequest } from "@/lib/studio-request-auth.server";

const LYRICS_MAX = 6000;
/** Minimum abort window for studio vocal dispatch HTTP calls. */
export const STUDIO_VOCAL_FETCH_TIMEOUT_MS = 60_000;
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = /^(audio\/(mpeg|wav|x-wav|wave|webm|mp4|aac)|video\/webm)$/i;
const ALLOWED_NAME = /\.(mp3|wav|webm|m4a)$/i;

/**
 * Studio vocal clone: recorded or uploaded take + lyrics → vocal stem URL
 * for the mixer. Provider names are never returned.
 */
export const Route = createFileRoute("/api/studio/vocal-clone")({
  server: {
    handlers: {
      POST: handleVocalClone,
      GET: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ status: "error", message: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

function fail(status: number, message: string): Response {
  return Response.json({ status: "error", message }, { status });
}

async function handleVocalClone({ request }: { request: Request }): Promise<Response> {
  let userId: string;
  try {
    userId = await studioUserIdFromRequest(request);
  } catch {
    return fail(401, "Sign in to clone vocals.");
  }

  try {
    limitBy("studioVocalClone", userId, RATE_LIMITS.generation, "vocal clones");
  } catch (error) {
    return fail(429, error instanceof Error ? error.message : "Too many vocal clones.");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return fail(400, "Send the vocal take as a multipart upload.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "That upload could not be read.");
  }

  const { parseTermsAccepted, VOCAL_CONSENT_REQUIRED_MESSAGE } = await import("@/lib/vocal-consent");
  if (!parseTermsAccepted(form.get("terms_accepted"))) {
    return fail(400, VOCAL_CONSENT_REQUIRED_MESSAGE);
  }

  const lyrics = String(form.get("lyrics_to_sing") ?? "").trim();
  if (lyrics.length < 1) return fail(400, "Add lyrics before cloning vocals from your take.");
  if (lyrics.length > LYRICS_MAX) return fail(400, "Those lyrics are too long.");

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail(400, "Upload or record a vocal take first.");
  }
  if (file.size > MAX_BYTES) {
    return fail(413, "That vocal take is too large. Keep clips under 25 MB.");
  }
  const namedOk = ALLOWED_NAME.test(file.name);
  const typedOk = !file.type || ALLOWED_TYPES.test(file.type);
  if (!namedOk && !typedOk) {
    return fail(400, "Upload a WAV or MP3 audio file.");
  }

  const audioBytes = new Uint8Array(await file.arrayBuffer());
  const wav = /\.wav$/i.test(file.name) || /wav/i.test(file.type);

  try {
    const { cloneVocalsFromBytes } = await import("@/lib/fish-tts.server");
    const result = await cloneVocalsFromBytes({
      audioBytes,
      lyrics,
      audioFormat: wav ? "wav" : "mp3",
      title: "Vocal stem",
      userId,
      taskId: newCorrelationId("vocal-clone"),
    });
    const vocalStemUrl = result.tracks.find((track) => track.audioUrl)?.audioUrl;
    if (!vocalStemUrl) {
      return fail(500, "Vocal generation failed.");
    }
    return Response.json({
      status: "success",
      vocalStemUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vocal generation failed.";
    return fail(500, message);
  }
}
