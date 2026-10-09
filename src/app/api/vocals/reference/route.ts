import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { vaultAdminClient } from "@/lib/vault-admin.server";

/** Separate from the 15 MB mic-take upload. A studio reference WAV can be 40 MB. */
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;

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

/** Drop a token query only on the public object URL. */
function stripPublicObjectToken(raw: string): string {
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!parsed.pathname.includes("/storage/v1/object/public/")) return raw;
  if (!parsed.searchParams.has("token")) return raw;
  parsed.searchParams.delete("token");
  parsed.search = parsed.searchParams.toString();
  return parsed.toString();
}

/**
 * POST /api/vocals/reference
 * Session bearer required. Stores a RIFF WAV at
 * vocal-references/${userId}/reference-${timestamp}.wav.
 * A multipart userId is ignored. Does not call create-voice.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !authorization.slice("Bearer ".length).trim()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let userId = "";
    try {
      const session = await resolveStudioSession(req);
      userId = session.userId.trim();
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const file = formData.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "No audio file provided" }, { status: 400 });
    }
    if (file.size <= 0 || file.size > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const uploadBytes = Buffer.from(arrayBuffer);
    if (uploadBytes.length <= 0 || uploadBytes.length > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }
    if (isWebmEbml(uploadBytes) || !isRiffWav(uploadBytes)) {
      return Response.json({ error: "Reference audio must be a WAV file." }, { status: 400 });
    }

    const storagePath = `vocal-references/${userId}/reference-${Date.now()}.wav`;
    const admin = vaultAdminClient();
    const { error: uploadError } = await admin.storage.from("audio-vault").upload(storagePath, uploadBytes, {
      contentType: "audio/wav",
      upsert: true,
    });
    if (uploadError) {
      console.error("[reference] upload failed");
      return Response.json({ error: "Could not store that reference." }, { status: 500 });
    }

    const { data } = admin.storage.from("audio-vault").getPublicUrl(storagePath);
    const publicUrl = stripPublicObjectToken(typeof data?.publicUrl === "string" ? data.publicUrl : "");
    if (!publicUrl.startsWith("https://") || publicUrl.includes("token=")) {
      console.error("[reference] public url missing");
      return Response.json({ error: "Could not store that reference." }, { status: 502 });
    }
    return Response.json({ url: publicUrl }, { status: 200 });
  } catch (err: unknown) {
    console.error("[reference] upload failed");
    const message = err instanceof Error && err.message.startsWith("Missing ") ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
