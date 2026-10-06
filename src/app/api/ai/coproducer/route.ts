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

function lyricsFromValue(value: unknown): string {
  const direct = nonEmpty(value);
  if (direct) return direct;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = lyricsFromValue(item);
      if (found) return found;
    }
    return "";
  }
  if (!isRecord(value)) return "";
  return (
    nonEmpty(value.lyrics) ||
    nonEmpty(value.text) ||
    nonEmpty(value.content) ||
    lyricsFromValue(value.output) ||
    lyricsFromValue(value.outputs) ||
    nonEmpty(value.result)
  );
}

function lyricsFrom(data: JsonRecord): string {
  const nested = isRecord(data.data) ? data.data : undefined;
  return (
    nonEmpty(data.lyrics) ||
    lyricsFromValue(data.output) ||
    lyricsFromValue(data.outputs) ||
    nonEmpty(data.result) ||
    (nested
      ? nonEmpty(nested.lyrics) ||
        lyricsFromValue(nested.output) ||
        lyricsFromValue(nested.outputs) ||
        nonEmpty(nested.result)
      : "")
  );
}

function titleFrom(data: JsonRecord, fallback: string): string {
  const task = isRecord(data.data) ? data.data : data;
  const output = task.outputs ?? task.output ?? task.result ?? data.outputs ?? data.output ?? data.result;
  if (isRecord(output)) {
    const titled = nonEmpty(output.title);
    if (titled) return titled;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isRecord(item)) continue;
      const titled = nonEmpty(item.title);
      if (titled) return titled;
    }
  }
  return nonEmpty(task.title) || fallback;
}

function taskIdFrom(data: JsonRecord): string {
  const task = isRecord(data.data) ? data.data : data;
  const id = nonEmpty(task.id) || nonEmpty(data.id);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return "";
  return id;
}

const LYRIC_POLL_INTERVAL_MS = 2000;
const LYRIC_POLL_ATTEMPTS = 25;
const TERMINAL_PREDICTION_STATUSES = new Set(["failed", "cancelled", "timeout", "deleted"]);

function resultUrlFrom(data: JsonRecord, predictionId: string): string {
  const task = isRecord(data.data) ? data.data : data;
  const urls = isRecord(task.urls) ? task.urls : undefined;
  const listed = nonEmpty(urls?.get);
  if (listed.startsWith("https://")) return listed;
  return `https://api.wavespeed.ai/api/v3/predictions/${encodeURIComponent(predictionId)}/result`;
}

function parseOutputPayload(rawOutputs: unknown): unknown {
  let outputPayload: unknown = Array.isArray(rawOutputs) ? rawOutputs[0] : rawOutputs;
  if (typeof outputPayload === "string") {
    const trimmed = outputPayload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        outputPayload = JSON.parse(trimmed) as unknown;
      } catch {
        return outputPayload;
      }
    }
  }
  return outputPayload;
}

function lyricsFromPayload(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (Array.isArray(payload)) return lyricsFromPayload(payload[0]);
  if (!isRecord(payload)) return "";
  return nonEmpty(payload.lyrics) || nonEmpty(payload.text) || nonEmpty(payload.content);
}

function titleFromPayload(payload: unknown, fallback: string): string {
  if (isRecord(payload)) return nonEmpty(payload.title) || fallback;
  if (Array.isArray(payload)) return titleFromPayload(payload[0], fallback);
  return fallback;
}

async function pollPredictionResult(resultUrl: string, apiKey: string): Promise<unknown> {
  for (let attempt = 0; attempt < LYRIC_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, LYRIC_POLL_INTERVAL_MS));
    const res = await fetch(resultUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;
    const raw = await res.text();
    let body: JsonRecord = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) continue;
      body = parsed;
    } catch {
      continue;
    }
    const task = isRecord(body.data) ? body.data : body;
    const status = nonEmpty(task.status).toLowerCase();
    if (status === "completed") return task.outputs;
    if (TERMINAL_PREDICTION_STATUSES.has(status)) {
      throw new Error(nonEmpty(task.error) || `Prediction ended with status: ${status}`);
    }
  }
  throw new Error("WaveSpeed prediction timed out after 50 seconds.");
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

    let result = lyricsFrom(data);
    let finalTitle = titleFrom(data, title.trim() || "Untitled Track");
    const submittedId = taskIdFrom(data);
    if (!result && !submittedId) {
      console.error("[WaveSpeed Submit Error]:", JSON.stringify(data, null, 2));
      return Response.json(
        { error: upstreamError(data, rawText) || "Failed to submit prediction." },
        { status: 500 },
      );
    }
    if (!result && submittedId) {
      const rawOutputs = await pollPredictionResult(resultUrlFrom(data, submittedId), apiKey);
      const outputPayload = parseOutputPayload(rawOutputs);
      result = lyricsFromPayload(outputPayload);
      finalTitle = titleFromPayload(outputPayload, title.trim() || "Untitled Track");
    }

    if (!result) {
      console.error("[WaveSpeed Raw Response]:", JSON.stringify(data, null, 2));
      return Response.json({ error: "WaveSpeed completed but returned empty lyrics." }, { status: 500 });
    }

    return Response.json({ success: true, title: finalTitle, lyrics: result, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[WaveSpeed Route Handler Error]:", err);
    return Response.json({ error: message || "Internal server error" }, { status: 500 });
  }
}
