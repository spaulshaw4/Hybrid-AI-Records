import { replicateBaseUrl } from "@/lib/ai-provider.server";

const EXTEND_LYRICS_SLUG = "mureka-ai/extend-lyrics";
const GENERATE_LYRICS_SLUG = "mureka-ai/generate-lyrics";
const STYLE_MODEL = "anthropic/claude-fable-5";
// Replicate rejects anthropic/claude-fable-5 unless max_tokens is at least 1024.
const FABLE_MAX_TOKENS = 1024;

const STYLE_ENHANCE_SYSTEM = `You are an executive music producer and prompt designer for Mureka AI audio generation.
Your job is to output a single-line sonic production descriptor under 40 words.
Specify: Genre/subgenre, core instrumentation, exact tempo (BPM), vocal gender/timbre (e.g., deep baritone male vocal, warm soulful vocal), and acoustic space.
CONTEXT RULES:
1. IF LYRICS ARE PROVIDED: Analyze the theme, rhythm, and emotional weight of the lyrics. Design a sonic style that naturally carries that vocal delivery.
2. IF A SEED KEYWORD IS PROVIDED (e.g., "rock", "lo-fi", "country"): Expand that seed into a complete, professional studio arrangement.
3. IF NEITHER ARE PROVIDED: Act as "Surprise Me". Select a distinct, high-impact commercial genre and generate an original production blueprint.
STRICT TERMINATION:
- Output EVERYTHING on ONE single line.
- Do NOT write lyrics, rhymes, or [Verse]/[Chorus] tags.
- Do NOT include conversational intros or explanations.
- Stop immediately after the final descriptor tag.`;

const SECTION_TAG = /\[(?:verse|chorus|intro|bridge|outro)\b[^\]]*\]/i;
const LYRIC_SECTION = /\[(Intro|Verse|Chorus|Bridge|Outro)/;

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

function firstFilled(...values: unknown[]): string {
  for (const value of values) {
    const text = textField(value).trim();
    if (text) return text;
  }
  return "";
}

function styleUserInstruction(userStyle: string, userLyrics: string): string {
  if (userStyle && userLyrics) {
    return `Expand this style seed "${userStyle}" while matching the mood, meter, and cadence of these lyrics:\n\n${userLyrics}`;
  }
  if (userLyrics) {
    return `Analyze these lyrics and create the ideal sonic style prompt to match their tone and cadence:\n\n${userLyrics}`;
  }
  if (userStyle) {
    return `Expand this style seed into a full production prompt: "${userStyle}"`;
  }
  return "Surprise me with a fresh, creative, and commercial music style prompt.";
}

function lyricTheme(body: JsonRecord): string {
  return firstFilled(body.topic, body.prompt, body.text, body.lyrics) || "A powerful personal story";
}

function lyricSystemPrompt(body: JsonRecord): string {
  const style = firstFilled(body.genre, body.prompt);
  const musicalContext = style ? `Musical Style Context: ${style}.\n` : "";
  return `You are a master songwriter and lyricist.
Write complete, compelling song lyrics based on the user's theme.
${musicalContext}MUREKA FORMATTING RULES:
1. Use standard structural headers on their own line: [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus], [Outro].
2. Keep line syllable counts balanced (7-10 syllables per line) so the singer locks naturally to the pocket.
3. Use grounded, evocative imagery. Avoid cheap pop clichés.
4. Output ONLY the bracketed sections and lyrics. Do NOT include titles, commentary, or conversational notes.
5. Terminate immediately after the last line of [Outro].`;
}

/** Drop a trailing block after [Outro] when the model leaves a triple newline. */
function cutLyricsAtTripleNewlineAfterOutro(generatedLyrics: string): string {
  const outroIndex = generatedLyrics.lastIndexOf("[Outro]");
  if (outroIndex !== -1) {
    const afterOutro = generatedLyrics.slice(outroIndex);
    const doubleNewlineIndex = afterOutro.indexOf("\n\n\n");
    if (doubleNewlineIndex !== -1) {
      generatedLyrics = generatedLyrics.slice(0, outroIndex + doubleNewlineIndex).trim();
    }
  }
  return generatedLyrics;
}

const FORMAT_LYRIC_SYSTEM = `You are a master songwriter and lyric editor.
Preserve the user's meaning and images.
Balance each lyric line to about 7-10 syllables.
Emit only Mureka section headers on their own lines: [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus], [Outro].
Terminate immediately after the final line of the [Outro].
No title. No commentary.`;

function formatLyricUserPrompt(draft: string, genre: string): string {
  const base = `Format and polish these lyrics for Mureka:\n${draft}`;
  return genre ? `${base}\nMusical Genre: ${genre}.` : base;
}

const COMMENTARY_START =
  /^(?:note\b|ps\b|p\.s\.|i hope\b|let me know\b|here(?:'s| is)\b|sure[,!]|commentary\b|thanks\b|hope this\b)/i;

function isCommentaryLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (COMMENTARY_START.test(text)) return true;
  const words = text.split(/\s+/).length;
  if (words >= 14 && /[.!?]/.test(text)) return true;
  return text.length > 120;
}

/** Keep lyric lines inside [Outro] and drop a trailing commentary block with no section header. */
function trimLyricsAtOutro(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized || !/\[Outro\]/i.test(normalized) || !LYRIC_SECTION.test(normalized)) return "";
  const lines = normalized.split("\n");
  const outroAt = lines.findIndex((line) => /\[Outro\]/i.test(line));
  if (outroAt < 0) return "";

  let end = lines.length;
  let seenOutroLyric = false;
  for (let i = outroAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      const rest = lines.slice(i + 1).join("\n").trim();
      if (!rest) {
        end = i;
        break;
      }
      if (/\[(Intro|Verse|Chorus|Bridge|Outro)/i.test(rest)) {
        end = i;
        break;
      }
      const nextContent = lines.slice(i + 1).find((item) => item.trim());
      if (seenOutroLyric && nextContent && isCommentaryLine(nextContent)) {
        end = i;
        break;
      }
      continue;
    }
    if (/^\[[^\]]+\]/.test(line.trim()) && !/\[Outro\]/i.test(line)) {
      end = i;
      break;
    }
    if (seenOutroLyric && isCommentaryLine(line)) {
      end = i;
      break;
    }
    seenOutroLyric = true;
  }

  return lines.slice(0, end).join("\n").trim();
}

function stripOneQuoteLayer(value: string): string {
  const text = value.trim();
  const match = text.match(/^(['"])([\s\S]*)\1$/);
  return match ? match[2]!.trim() : text;
}

/**
 * Hybrid token first. Lyric keys are used only when they are not the hybrid token,
 * matching lyricReplicateToken() which refuses that collision. Never logs the token.
 */
function styleEnhanceToken(): string {
  const replicateToken = process.env.REPLICATE_API_TOKEN?.trim() || "";
  if (replicateToken) return replicateToken;
  const replicateKey = process.env.REPLICATE_API_KEY?.trim() || "";
  if (replicateKey) return replicateKey;

  const lyric = process.env.LYRIC_ENGINE_API_KEY?.trim() || process.env.ENGINE_API_KEY?.trim() || "";
  if (!lyric) return "";
  const hybrid = process.env.REPLICATE_API_TOKEN?.trim() || process.env.REPLICATE_API_KEY?.trim() || "";
  if (hybrid && lyric === hybrid) return "";
  return lyric;
}

function styleTextFromOutput(output: unknown): string {
  if (Array.isArray(output)) return output.join("").trim();
  if (output == null) return "";
  return String(output).trim();
}

function shortProviderError(rawText: string, data: JsonRecord, fallback = "Style enhancement failed."): string {
  const err = data.error;
  if (typeof err === "string" && err.trim()) return err.trim().slice(0, 300);
  if (isRecord(err)) {
    const nested = nonEmpty(err.message) || nonEmpty(err.detail);
    if (nested) return nested.slice(0, 300);
  }
  const detail = nonEmpty(data.detail) || nonEmpty(data.message);
  if (detail) return detail.slice(0, 300);
  const compact = rawText.trim().replace(/\s+/g, " ");
  if (!compact) return fallback;
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

function parseJsonRecord(rawText: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (isRecord(parsed)) return parsed;
  } catch {
    return {};
  }
  return {};
}

type ClaudeInput = {
  prompt: string;
  system_prompt: string;
  max_tokens: number;
  temperature: number;
};

/**
 * Same Replicate predictions HTTP shape as replicateChat / optimize-prompt:
 * POST /models/{owner}/{name}/predictions, then poll /predictions/{id}.
 * Never calls WaveSpeed. Never logs the token or Authorization.
 */
async function callClaudeFable(input: ClaudeInput, failureLabel: string): Promise<string> {
  const token = styleEnhanceToken();
  if (!token) {
    throw new Error("Missing REPLICATE_API_TOKEN in environment variables.");
  }

  const base = replicateBaseUrl();
  const res = await fetch(`${base}/models/${STYLE_MODEL}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input }),
  });

  const rawText = await res.text();
  const data = parseJsonRecord(rawText);
  if (!res.ok) {
    throw new Error(shortProviderError(rawText, data, failureLabel));
  }

  let prediction = data;
  let status = nonEmpty(prediction.status).toLowerCase();
  const predictionId = nonEmpty(prediction.id);
  const deadline = Date.now() + 60_000;
  while (predictionId && status && status !== "succeeded" && status !== "failed" && status !== "canceled") {
    if (Date.now() > deadline) {
      throw new Error(`${failureLabel} timed out.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const poll = await fetch(`${base}/predictions/${encodeURIComponent(predictionId)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const pollText = await poll.text();
    const pollData = parseJsonRecord(pollText);
    if (!poll.ok) {
      throw new Error(shortProviderError(pollText, pollData, failureLabel));
    }
    prediction = pollData;
    status = nonEmpty(prediction.status).toLowerCase();
  }

  if (status && status !== "succeeded") {
    throw new Error(shortProviderError(rawText, prediction, failureLabel));
  }

  return stripOneQuoteLayer(styleTextFromOutput(prediction.output));
}

async function enhanceMusicalStyle(body: JsonRecord): Promise<Response> {
  const userStyle = firstFilled(body.prompt, body.topic, body.text);
  const userLyrics = textField(body.lyrics).trim();
  const rawStyle = await callClaudeFable(
    {
      prompt: styleUserInstruction(userStyle, userLyrics),
      system_prompt: STYLE_ENHANCE_SYSTEM,
      max_tokens: FABLE_MAX_TOKENS,
      temperature: 0.7,
    },
    "Style enhancement",
  );
  const enhancedText = rawStyle.split("\n")[0]?.trim() ?? "";
  if (!enhancedText || SECTION_TAG.test(enhancedText)) {
    return Response.json({ error: "Style enhancement returned an empty prompt." }, { status: 500 });
  }

  return Response.json({ success: true, style: enhancedText, prompt: enhancedText });
}

async function generateClaudeLyrics(body: JsonRecord): Promise<Response> {
  const theme = lyricTheme(body);
  const requestTitle = textField(body.title).trim();
  const generated = (await callClaudeFable(
    {
      system_prompt: lyricSystemPrompt(body),
      prompt: `Write complete song lyrics about: "${theme}"`,
      max_tokens: FABLE_MAX_TOKENS,
      temperature: 0.7,
    },
    "Lyric generation",
  )).replace(/\r\n/g, "\n");
  const lyrics = cutLyricsAtTripleNewlineAfterOutro(generated);
  if (!lyrics || lyrics.lastIndexOf("[Outro]") === -1 || !LYRIC_SECTION.test(lyrics)) {
    return Response.json({ error: "Lyric generation returned no sectioned lyrics." }, { status: 500 });
  }

  const title = requestTitle || "Untitled Track";
  return Response.json({ success: true, title, lyrics, result: lyrics });
}

async function formatClaudeLyrics(body: JsonRecord): Promise<Response> {
  const draft = textField(body.lyrics).trim();
  if (!draft) {
    return Response.json({ error: "Provide lyrics to format." }, { status: 400 });
  }
  const genre = textField(body.genre).trim();
  const generated = await callClaudeFable(
    {
      system_prompt: FORMAT_LYRIC_SYSTEM,
      prompt: formatLyricUserPrompt(draft, genre),
      max_tokens: FABLE_MAX_TOKENS,
      temperature: 0.5,
    },
    "Lyric generation",
  );
  const lyrics = trimLyricsAtOutro(generated);
  if (!lyrics || !LYRIC_SECTION.test(lyrics) || !/\[Outro\]/i.test(lyrics)) {
    return Response.json({ error: "Lyric generation returned no sectioned lyrics." }, { status: 500 });
  }
  return Response.json({ success: true, lyrics, result: lyrics });
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
 * enhance_prompt / enhance_style, generate_lyrics, and format_lyrics use Replicate Claude Fable.
 * next_line and every other lyric action stay on WaveSpeed.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const rawRequest = await req.text();
    let body: JsonRecord = { raw: rawRequest };
    try {
      const parsed: unknown = JSON.parse(rawRequest);
      if (isRecord(parsed)) body = parsed;
    } catch {
      body = { raw: rawRequest };
    }

    const action = textField(body.action);
    if (
      action === "enhance_prompt" ||
      action === "enhance_style" ||
      action === "generate_style" ||
      action === "generate_lyrics" ||
      action === "format_lyrics"
    ) {
      try {
        if (action === "generate_lyrics") return await generateClaudeLyrics(body);
        if (action === "format_lyrics") return await formatClaudeLyrics(body);
        return await enhanceMusicalStyle(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        console.error("[Coproducer Route Error]", err);
        return Response.json({ error: message || "Failed to process coproducer request." }, { status: 500 });
      }
    }

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WAVESPEED_API_KEY in environment variables." }, { status: 500 });
    }

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
