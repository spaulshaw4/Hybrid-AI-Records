import { resolveStudioSession } from "@/lib/studio-request-auth.server";

/** Official model inputs include prompt and a single audio URI. */
const PREDICT_URL = "https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions";

/**
 * Published Input schema for google/gemini-3.5-flash: `audio` is a uri.
 * `file` and `files` are not input properties.
 */
const ANALYSIS_PROMPT = `Listen to this master audio track closely.
Extract its core acoustic and production DNA.
Return ONLY valid JSON matching this schema:
{
  "tags": "BPM, key musical key, primary instrumentation, rhythmic groove, vocal texture (max 100 characters)"
}`;

const CLIENT_ERROR = "Failed to analyze reference audio";

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

function tagsFromOutput(output: unknown): string {
  const parsed: unknown = JSON.parse(stripJsonFence(textFromOutput(output)));
  if (!parsed || typeof parsed !== "object") return "";
  const tags = (parsed as { tags?: unknown }).tags;
  return typeof tags === "string" ? tags.trim() : "";
}

function projectHost(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || "";
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "169.254.169.254") return true;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Public audio-vault reference for this session. Signed URLs are rejected. */
function gatePublicReferenceUrl(raw: string, userId: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !userId) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHost(host)) return "";
  const expected = projectHost();
  if (!expected || host !== expected) return "";
  if (parsed.pathname.includes("/object/sign/")) return "";
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === "token") return "";
  }
  const marker = `/storage/v1/object/public/audio-vault/references/${userId}/`;
  if (!parsed.pathname.includes(marker)) return "";
  return trimmed;
}

function executionFailed(error: unknown): Response {
  console.error("[audio-to-prompt] execution failed:", error);
  return Response.json({ error: CLIENT_ERROR }, { status: 500 });
}

/**
 * POST /api/reference/audio-to-prompt
 * Session bearer required. Body userId is ignored.
 * Forwards a public reference URL as input.audio.
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

    const { audioUrl } = (await req.json()) as { audioUrl?: unknown };
    if (typeof audioUrl !== "string" || !audioUrl.trim()) {
      return Response.json({ error: "Missing audioUrl" }, { status: 400 });
    }

    const gated = gatePublicReferenceUrl(audioUrl, userId);
    if (!gated) return Response.json({ error: CLIENT_ERROR }, { status: 400 });

    const token = process.env.REPLICATE_API_TOKEN?.trim() ?? "";
    if (!token) return executionFailed(new Error(CLIENT_ERROR));

    const upstream = await fetch(PREDICT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          audio: gated,
          prompt: ANALYSIS_PROMPT,
        },
      }),
    });

    const payload = (await upstream.json()) as { status?: unknown; output?: unknown };
    const tags = tagsFromOutput(payload.output);
    if (!upstream.ok || payload.status !== "succeeded" || !tags) {
      return executionFailed(new Error(CLIENT_ERROR));
    }
    return Response.json({ success: true, tags });
  } catch (error) {
    return executionFailed(error);
  }
}
