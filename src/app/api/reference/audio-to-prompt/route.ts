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

function instrumentList(value: unknown): string[] {
  const parts = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const instruments: string[] = [];
  for (const item of parts) {
    const name = nonEmptyString(item);
    if (name) instruments.push(name);
  }
  return instruments;
}

function logAnalysisGap(detail: string): void {
  console.error(`[audio-to-prompt] ${detail}`);
}

function analysisFromOutput(output: unknown): ReferenceAnalysis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(textFromOutput(output)));
  } catch {
    logAnalysisGap("invalid json");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logAnalysisGap("invalid json");
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const tags = nonEmptyString(row.tags);
  const key = nonEmptyString(row.key);
  const genre = nonEmptyString(row.genre);
  const groove = nonEmptyString(row.groove);
  const missing = [
    tags ? "" : "tags",
    key ? "" : "key",
    genre ? "" : "genre",
    groove ? "" : "groove",
  ].filter((field) => field);
  if (missing.length > 0) {
    for (const field of missing) logAnalysisGap(`missing ${field}`);
    return null;
  }
  let bpm = typeof row.bpm === "number" ? row.bpm : parseInt(String(row.bpm), 10);
  if (!Number.isFinite(bpm)) bpm = 120;
  const vocalStyle = nonEmptyString(row.vocal_style) || "instrumental / none";
  const instruments = instrumentList(row.instruments);
  if (instruments.length === 0) {
    logAnalysisGap("empty instruments");
    return null;
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
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"] as const;
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (host) return host;
    } catch {
      continue;
    }
  }
  return "";
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "169.254.169.254") return true;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

function validationFailed(field: string, reason: string): void {
  console.error(`[audio-to-prompt] validation failed: ${field} ${reason}`);
}

function canonicalStoragePath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    path = pathname;
  }
  return path.replace(/\/{2,}/g, "/");
}

/** Public audio-vault reference for this session. Signed URLs are rejected. */
function gatePublicReferenceUrl(raw: string, userId: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    validationFailed("audioUrl", "empty");
    return "";
  }
  if (!userId) {
    validationFailed("audioUrl", "session user");
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    validationFailed("audioUrl", "invalid");
    return "";
  }
  if (parsed.protocol !== "https:") {
    validationFailed("audioUrl", "protocol");
    return "";
  }
  if (parsed.username || parsed.password) {
    validationFailed("audioUrl", "credentials");
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isBlockedHost(host)) {
    validationFailed("audioUrl", "blocked host");
    return "";
  }
  const expected = projectHost();
  if (!expected || host !== expected) {
    validationFailed("audioUrl", "host");
    return "";
  }
  const path = canonicalStoragePath(parsed.pathname);
  if (path.includes("/object/sign/")) {
    validationFailed("audioUrl", "signed");
    return "";
  }
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === "token") {
      validationFailed("audioUrl", "token query");
      return "";
    }
  }
  const marker = `/storage/v1/object/public/audio-vault/references/${userId}/`;
  if (!path.toLowerCase().includes(marker.toLowerCase())) {
    validationFailed("audioUrl", "path");
    return "";
  }
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
      validationFailed("authorization", "missing");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let userId = "";
    try {
      const session = await resolveStudioSession(req);
      userId = session.userId.trim();
    } catch {
      validationFailed("session", "unauthorized");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!userId) {
      validationFailed("session", "missing user");
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let requestBody: unknown;
    try {
      requestBody = await req.json();
    } catch {
      validationFailed("audioUrl", "json");
      return Response.json({ error: CLIENT_ERROR }, { status: 400 });
    }
    const audioUrl =
      requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
        ? (requestBody as { audioUrl?: unknown }).audioUrl
        : undefined;
    if (typeof audioUrl !== "string" || !audioUrl.trim()) {
      validationFailed("audioUrl", "missing");
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
    if (!upstream.ok || payload.status !== "succeeded") {
      return executionFailed(new Error(CLIENT_ERROR));
    }
    const analysis = analysisFromOutput(payload.output);
    if (!analysis) {
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
