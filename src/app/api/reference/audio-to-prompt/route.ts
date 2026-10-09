import { resolveStudioSession } from "@/lib/studio-request-auth.server";

/** Official model inputs include prompt, images, videos, and a single audio URI. */
const PREDICT_URL = "https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;

const ANALYSIS_PROMPT =
  "You are an executive music producer for Hybrid AI Records. Analyze this audio recording and extract its musical DNA. Return ONLY a comma-separated list of: 1. Primary genre and subgenres 2. Key instruments (e.g. analog synth, heavy distorted bass, brass section) 3. Estimated tempo/rhythm feel (e.g. driving mid-tempo, 120 bpm) 4. Production mix aesthetic (e.g. tube saturation, wide stereo field, dry punchy drums) 5. Vocal profile if present (e.g. soaring rock tenor, soulful female alto) Keep the entire output under 150 characters, formatted strictly as plain text tags without bullet points or introductory commentary.";

function isWebmEbml(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
}

function isRiffWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function isMpegAudio(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") return true;
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function tagsFromOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => (typeof part === "string" ? part : ""))
    .join("")
    .trim();
}

function failed(): Response {
  console.error("[audio-to-prompt] analysis failed");
  return Response.json({ error: "Failed to analyze audio" }, { status: 500 });
}

/**
 * POST /api/reference/audio-to-prompt
 * Session bearer required. A form userId is ignored.
 * File input is mapped onto the model's audio URI field.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !authorization.slice("Bearer ".length).trim()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
      const session = await resolveStudioSession(req);
      if (!session.userId.trim()) return Response.json({ error: "Unauthorized" }, { status: 401 });
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const uploaded = formData.get("file") ?? formData.get("audio");
    if (!(uploaded instanceof Blob)) {
      return Response.json({ error: "No audio file provided" }, { status: 400 });
    }
    if (uploaded.size <= 0 || uploaded.size > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }

    const uploadBytes = Buffer.from(await uploaded.arrayBuffer());
    if (uploadBytes.length <= 0 || uploadBytes.length > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }
    if (isWebmEbml(uploadBytes) || (!isRiffWav(uploadBytes) && !isMpegAudio(uploadBytes))) {
      return Response.json({ error: "Reference audio must be a WAV file." }, { status: 400 });
    }

    const token = process.env.REPLICATE_API_TOKEN?.trim() ?? "";
    if (!token) return failed();

    const mime = isRiffWav(uploadBytes) ? "audio/wav" : "audio/mpeg";
    const dataUri = `data:${mime};base64,${uploadBytes.toString("base64")}`;
    const filename = uploaded instanceof File && uploaded.name.trim() ? uploaded.name.trim() : "reference.wav";

    let upstream: Response;
    try {
      upstream = await fetch(PREDICT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          input: {
            prompt: ANALYSIS_PROMPT,
            audio: dataUri,
          },
        }),
      });
    } catch {
      return failed();
    }

    let payload: { status?: unknown; output?: unknown } = {};
    try {
      const parsed: unknown = await upstream.json();
      if (parsed && typeof parsed === "object") payload = parsed as { status?: unknown; output?: unknown };
    } catch {
      return failed();
    }

    const tags = tagsFromOutput(payload.output);
    if (!upstream.ok || payload.status !== "succeeded" || !tags) return failed();
    return Response.json({ success: true, tags, filename });
  } catch {
    return failed();
  }
}
