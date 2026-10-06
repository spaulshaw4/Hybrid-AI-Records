const EXTEND_LYRICS_SLUG = "mureka-ai/extend-lyrics";
const GENERATE_LYRICS_SLUG = "mureka-ai/generate-lyrics";

const RANDOM_LYRIC_THEMES = [
  "Late night drive under neon lights and moonlit skies",
  "A soulful ballad about letting go of what held you back",
  "Gritty Southern rock story about dusty roads and second chances",
  "Vulnerable bedroom pop about keeping feelings hidden in the dark",
  "An anthemic acoustic rock track about breaking out of routine",
];

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function shortJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return "";
  }
}

function upstreamError(data: JsonRecord, rawText: string): string {
  const message = nonEmpty(data.message);
  if (message) return message;

  const err = data.error;
  if (err && typeof err === "object") {
    if (isRecord(err)) {
      const nested = nonEmpty(err.message);
      if (nested) return nested;
    }
    const slice = shortJson(err);
    if (slice) return slice;
  } else {
    const errorText = nonEmpty(err);
    if (errorText) return errorText;
  }

  const detail = nonEmpty(data.detail);
  if (detail) return detail;
  if (data.detail && typeof data.detail === "object") {
    const slice = shortJson(data.detail);
    if (slice) return slice;
  }

  if (rawText.trim()) return rawText;
  return "WaveSpeed Mureka call failed.";
}

function lyricsFrom(data: JsonRecord): string {
  const nested = isRecord(data.data) ? data.data : undefined;
  return (
    nonEmpty(data.lyrics) ||
    nonEmpty(nested?.lyrics) ||
    nonEmpty(data.result) ||
    nonEmpty(data.output) ||
    nonEmpty(nested?.output) ||
    nonEmpty(nested?.result)
  );
}

/**
 * POST /api/ai/coproducer
 * Lyric workshop and style enhance actions via WaveSpeed Mureka lyrics models.
 * next_line extends the current lyric sheet; every other action generates lyrics.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WAVESPEED_API_KEY in environment variables." }, { status: 500 });
    }

    const rawRequest = await req.text();
    let body: JsonRecord = { raw: rawRequest };
    try {
      const parsed: unknown = JSON.parse(rawRequest);
      if (isRecord(parsed)) body = parsed;
    } catch {
      body = { raw: rawRequest };
    }

    const action = textField(body.action);
    const lyrics = textField(body.lyrics);
    const title = textField(body.title);
    const prompt = textField(body.prompt);
    const topic = textField(body.topic);
    const text = textField(body.text);
    const isExtend = action === "next_line";
    const modelSlug = isExtend ? EXTEND_LYRICS_SLUG : GENERATE_LYRICS_SLUG;
    const randomFallback = RANDOM_LYRIC_THEMES[Math.floor(Math.random() * RANDOM_LYRIC_THEMES.length)] ?? RANDOM_LYRIC_THEMES[0];
    const rawInput = [topic, prompt, text, lyrics].map((value) => value.trim()).find((value) => value.length > 0) ?? "";
    const effectivePrompt = rawInput || randomFallback;
    const payload = isExtend
      ? {
          lyrics: lyrics.trim() || effectivePrompt,
          num_lines: 2,
        }
      : {
          prompt: effectivePrompt,
          title: title.trim() || "Untitled Track",
        };

    const res = await fetch(`https://api.wavespeed.ai/api/v3/${modelSlug}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await res.text();
    console.log(`[WaveSpeed Mureka] ${action} ${modelSlug} ${res.status}`, rawText);

    let data: JsonRecord = { raw: rawText };
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (isRecord(parsed)) data = parsed;
    } catch {
      data = { raw: rawText };
    }

    if (!res.ok) {
      return Response.json({ error: upstreamError(data, rawText) }, { status: res.status });
    }

    const result = lyricsFrom(data);
    if (!result) {
      const snippet = rawText.length > 400 ? `${rawText.slice(0, 400)}…` : rawText;
      return Response.json(
        { error: `WaveSpeed Mureka returned no lyrics. ${snippet}` },
        { status: 502 },
      );
    }

    return Response.json({ success: true, lyrics: result, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
