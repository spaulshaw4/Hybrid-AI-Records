import { resolveStudioSession } from "@/lib/studio-request-auth.server";

/** Official model inputs include prompt and a single audio URI. */
const PREDICT_URL = "https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions";

/**
 * Published Input schema for google/gemini-3.5-flash: `audio` is a uri.
 * `file` and `files` are not input properties.
 */
const ANALYSIS_PROMPT = `Listen to this audio track closely.
Extract its core acoustic and production DNA.
Return ONLY valid JSON matching this schema:
{
  "bpm": 120,
  "key": "C minor",
  "genre": "Symphonic Rock / Cinematic",
  "instruments": ["distorted electric guitar", "live drums", "cello", "sub bass"],
  "groove": "driving halftime with heavy backbeat",
  "vocal_style": "gritty baritone, dry plate reverb",
  "tags": "120 BPM, C minor, driving symphonic rock, heavy drums, gritty baritone"
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

type ReferenceAnalysis = {
  bpm: number;
  key: string;
  genre: string;
  instruments: string[];
  groove: string;
  vocal_style: string;
  tags: string;
};

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function analysisFromOutput(output: unknown): ReferenceAnalysis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(textFromOutput(output)));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const tags = nonEmptyString(row.tags);
  const key = nonEmptyString(row.key);
  const genre = nonEmptyString(row.genre);
  const groove = nonEmptyString(row.groove);
  const vocalStyle = nonEmptyString(row.vocal_style);
  const bpm = row.bpm;
  if (!tags || !key || !genre || !groove || !vocalStyle) return null;
  if (typeof bpm !== "number" || !Number.isFinite(bpm)) return null;
  if (!Array.isArray(row.instruments) || row.instruments.length === 0) return null;
  const instruments: string[] = [];
  for (const item of row.instruments) {
    const name = nonEmptyString(item);
    if (!name) return null;
    instruments.push(name);
  }
  return {
    bpm,
    key,
    genre,
    instruments,
    groove,
    vocal_style: vocalStyle,
    tags,
  };
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
    const analysis = analysisFromOutput(payload.output);
    if (!upstream.ok || payload.status !== "succeeded" || !analysis) {
      return executionFailed(new Error(CLIENT_ERROR));
    }
    return Response.json({
      success: true,
      bpm: analysis.bpm,
      key: analysis.key,
      genre: analysis.genre,
      instruments: analysis.instruments,
      groove: analysis.groove,
      vocal_style: analysis.vocal_style,
      tags: analysis.tags,
    });
  } catch (error) {
    return executionFailed(error);
  }
}
