import { resolveStudioSession } from "@/lib/studio-request-auth.server";

/** Official image input is images. There is no image field. */
const PREDICT_URL = "https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const VISUAL_PROMPT = `Analyze this image's mood, color palette, and narrative.
Generate a complete song configuration matching its atmosphere.
Return ONLY valid JSON matching this schema:
{
  "title": "Impactful 2-4 word title",
  "tags": "Comma-separated genre, BPM, key instruments, vocal style (max 120 chars)",
  "lyrics": "Complete song lyrics with bracketed markers [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro]"
}`;

type ImageMime = "image/png" | "image/jpeg" | "image/webp";

function sniffedImage(buffer: Buffer): ImageMime | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function textFromOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map((part) => (typeof part === "string" ? part : "")).join("");
}

function stripJsonFence(raw: string): string {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function songFromParsed(value: unknown): { title: string; tags: string; lyrics: string } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { title?: unknown; tags?: unknown; lyrics?: unknown };
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const tags = typeof row.tags === "string" ? row.tags.trim() : "";
  const lyrics = typeof row.lyrics === "string" ? row.lyrics.trim() : "";
  if (!title || !tags || !lyrics) return null;
  return { title, tags, lyrics };
}

function failed(): Response {
  console.error("[visual-injection] error");
  return Response.json({ error: "Failed to process visual injection" }, { status: 500 });
}

/**
 * POST /api/reference/visual-injection
 * Session bearer required. A form userId is ignored.
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
    const uploaded = formData.get("file");
    if (!(uploaded instanceof Blob)) {
      return Response.json({ error: "Missing image file" }, { status: 400 });
    }
    if (uploaded.size <= 0 || uploaded.size > MAX_IMAGE_BYTES) {
      return Response.json({ error: "File empty or exceeds 10MB limit" }, { status: 400 });
    }

    const uploadBytes = Buffer.from(await uploaded.arrayBuffer());
    if (uploadBytes.length <= 0 || uploadBytes.length > MAX_IMAGE_BYTES) {
      return Response.json({ error: "File empty or exceeds 10MB limit" }, { status: 400 });
    }
    const mime = sniffedImage(uploadBytes);
    if (!mime) {
      return Response.json({ error: "Image must be PNG, JPEG, or WebP." }, { status: 400 });
    }

    const token = process.env.REPLICATE_API_TOKEN?.trim() ?? "";
    if (!token) return failed();

    const dataUri = `data:${mime};base64,${uploadBytes.toString("base64")}`;
    const filename = uploaded instanceof File && uploaded.name.trim() ? uploaded.name.trim() : "image.png";

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
            prompt: VISUAL_PROMPT,
            images: [dataUri],
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

    let song: { title: string; tags: string; lyrics: string } | null = null;
    try {
      song = songFromParsed(JSON.parse(stripJsonFence(textFromOutput(payload.output))));
    } catch {
      song = null;
    }
    if (!upstream.ok || payload.status !== "succeeded" || !song) return failed();
    return Response.json({ success: true, title: song.title, tags: song.tags, lyrics: song.lyrics, filename });
  } catch {
    return failed();
  }
}
