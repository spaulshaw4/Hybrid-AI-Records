/**
 * Style Prompt Optimizer — Gemini 2.5 Flash on Replicate.
 * Genre-adaptive dense style tokens + structural lyric anchors for Gate 1.
 */

import { replicateBaseUrl, replicateApiKey } from "@/lib/ai-provider.server";
import {
  joinReplicateOutput,
  REPLICATE_GEMINI_FLASH,
} from "@/lib/replicate-llm.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";

const OPTIMIZER_LABEL = "Style Prompt Optimizer";
const MAX_USER_TEXT = 4000;
const MAX_LYRICS_CONTEXT = 6000;

export type OptimizedStyleResult = {
  stylePrompt: string;
  lyricAnchors: string[];
};

/** Genre-adaptive dual-output instruction (style tokens + lyric structure anchors). */
export function buildStyleOptimizePrompt(
  userText: string,
  options: { lyrics?: string } = {},
): string {
  const concept = userText.trim().slice(0, MAX_USER_TEXT);
  const lyrics = (options.lyrics ?? "").trim().slice(0, MAX_LYRICS_CONTEXT);

  const lyricsBlock = lyrics
    ? `Existing lyrics (adapt anchors to this form; do not rewrite sung lines):\n"""\n${lyrics}\n"""`
    : "Existing lyrics: (none — invent a concise genre-faithful section roadmap of bracket anchors only).";

  return `You are an expert multi-genre music producer and arrangement coach. Analyze the user's requested genre/vibe and compile outputs that match THAT genre's core acoustic signature — never default to rock/grunge instruments unless the user asked for rock/grunge.

DYNAMIC STYLE COMPILATION
- Output dense comma-separated priority tokens only for STYLE_TOKENS — no narrative sentences, no semicolon prose, no "X carries the hook while Y fills the space".
- Adapt every token to the detected genre (rap/hip-hop, EDM, R&B, metal, jazz, country, afrobeat, latin, folk, classical crossover, etc.).
- Strict STYLE_TOKENS lead order:
[Tempo/BPM], [Primary Low-End/Bass Instrument for that genre], [Primary Drum/Percussion Kit for that genre], [Harmonic/Melodic Layers], [Vocal Style & Delivery], [Atmosphere/Mix Profile], [Theme/Concept]
- Always preserve that genre's characteristic low-end and rhythm engine (whatever is authentic for THAT style — e.g. 808 sub + trap hats for modern rap; four-on-the-floor kick + sidechained bass for house; upright bass + brushed kit for jazz; slap bass + tight funk kit for funk). Do not dilute into generic prose.
- Never hardcode rock guitars, grunge tones, or "punchy acoustic drums" unless the concept is rock/grunge-adjacent.

DUAL OUTPUT — LYRIC_ANCHORS
- Also return genre-matching structural bracket tags for the lyric sheet so the generator locks to that style's rhythm/tempo language.
- Examples of the *kind* of anchors (do not copy blindly — invent for the detected genre):
  rap/trap → [808 Bass Intro], [Hook - Booming Low End]
  rock → [Intro - Heavy Bass Riff], [Chorus - Full Band]
  house/EDM → [Intro - Four on the Floor], [Drop - Sub Bass]
  R&B → [Intro - Warm Sub Groove], [Chorus - Stacked Harmonies]
- Anchors must be single-line bracket tags like [Section - Genre Cue]. Prefer 4–8 anchors covering intro → verses/hooks → bridge/outro as fits the genre.

OUTPUT FORMAT — return EXACTLY two labeled blocks and nothing else (no markdown fences, no commentary):

STYLE_TOKENS:
<single line of comma-separated tags>

LYRIC_ANCHORS:
[First Anchor]
[Second Anchor]
...

User Concept: "${concept}"
${lyricsBlock}`;
}

/** Strip markdown fences / wrapping quotes Gemini sometimes adds. */
export function cleanOptimizedStylePrompt(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:[\w-]*)?\s*/i, "").replace(/\s*```$/i, "");
  text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
  text = text.replace(/^(?:here(?:'s| is)|optimized(?: style)?(?: prompt)?)\s*[:\-–—]\s*/i, "");
  return text.replace(/\s+/g, " ").trim();
}

function normalizeAnchorTag(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^\[([^\]]+)\]$/);
  if (!match) return null;
  const inner = match[1]!.replace(/\s+/g, " ").trim();
  if (!inner || inner.length > 80) return null;
  return `[${inner}]`;
}

/**
 * Parse Gemini dual-output into style tokens + lyric structure anchors.
 * Falls back to treating the whole string as STYLE_TOKENS when labels are missing.
 */
export function parseOptimizedStyleOutput(raw: string): OptimizedStyleResult {
  let text = raw.trim();
  text = text.replace(/^```(?:[\w-]*)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const styleMatch = text.match(
    /STYLE_TOKENS\s*:\s*([\s\S]*?)(?=\n\s*LYRIC_ANCHORS\s*:|$)/i,
  );
  const anchorsMatch = text.match(/LYRIC_ANCHORS\s*:\s*([\s\S]*)$/i);

  let stylePrompt = "";
  if (styleMatch) {
    stylePrompt = cleanOptimizedStylePrompt(styleMatch[1] ?? "");
  } else if (!/LYRIC_ANCHORS\s*:/i.test(text)) {
    stylePrompt = cleanOptimizedStylePrompt(text);
  }

  const lyricAnchors: string[] = [];
  if (anchorsMatch) {
    for (const line of (anchorsMatch[1] ?? "").split(/\r?\n/)) {
      const tag = normalizeAnchorTag(line.replace(/^[-*•]\s*/, ""));
      if (tag) lyricAnchors.push(tag);
    }
  }

  return {
    stylePrompt: stylePrompt.slice(0, 6000),
    lyricAnchors: lyricAnchors.slice(0, 16),
  };
}

/**
 * Inject genre-adaptive bracket anchors into the lyric sheet without rewriting
 * sung lines. Empty lyrics → anchor roadmap; existing tags → replace in order.
 */
export function injectLyricStructureAnchors(lyrics: string, anchors: string[]): string {
  const tags = anchors
    .map((a) => normalizeAnchorTag(a) ?? normalizeAnchorTag(`[${a.replace(/^\[|\]$/g, "")}]`))
    .filter((t): t is string => Boolean(t));
  if (tags.length === 0) return lyrics;

  const text = lyrics.replace(/\r\n?/g, "\n").trim();
  if (!text) return tags.join("\n\n");

  const tagLine = /^\s*\[[^\]]+\]\s*$/;
  const lines = text.split("\n");
  const existingTagIndexes = lines
    .map((line, index) => (tagLine.test(line) ? index : -1))
    .filter((index) => index >= 0);

  if (existingTagIndexes.length === 0) {
    return `${tags.join("\n")}\n\n${text}`;
  }

  let anchorIdx = 0;
  const next = lines.map((line) => {
    if (!tagLine.test(line) || anchorIdx >= tags.length) return line;
    return tags[anchorIdx++]!;
  });

  if (anchorIdx < tags.length) {
    const lastTagAt =
      [...next.keys()].reverse().find((i) => tagLine.test(next[i]!)) ?? next.length - 1;
    next.splice(lastTagAt + 1, 0, ...tags.slice(anchorIdx));
  }

  return next.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${replicateApiKey(OPTIMIZER_LABEL)}`,
  };
}

/**
 * Runs google/gemini-2.5-flash via Replicate with REPLICATE_API_TOKEN
 * (alias: REPLICATE_API_KEY).
 */
export async function optimizeStylePromptViaGemini(
  userText: string,
  options: { timeoutMs?: number; lyrics?: string } = {},
): Promise<OptimizedStyleResult> {
  const trimmed = userText.trim();
  if (trimmed.length < 2) {
    throw new Error("Add a short style concept before optimizing.");
  }

  const prompt = buildStyleOptimizePrompt(trimmed, { lyrics: options.lyrics });
  const base = replicateBaseUrl();
  const headers = authHeaders();

  const create = await resilientFetch(
    `${base}/models/${REPLICATE_GEMINI_FLASH}/predictions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          prompt,
          temperature: 0.45,
          max_output_tokens: 768,
          thinking_budget: 0,
        },
      }),
    },
    {
      label: OPTIMIZER_LABEL,
      retries: 2,
      timeoutMs: 60_000,
      baseDelayMs: 1500,
      respectRetryAfter: true,
    },
  );

  if (!create.ok) {
    const body = await create.text().catch(() => "");
    throw new Error(`${OPTIMIZER_LABEL} failed [${create.status}]: ${body.slice(0, 400)}`);
  }

  let prediction = (await create.json()) as {
    id?: string;
    status?: string;
    output?: unknown;
    error?: string;
  };

  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (
    prediction.id &&
    prediction.status &&
    !["succeeded", "failed", "canceled"].includes(prediction.status)
  ) {
    if (Date.now() > deadline) {
      throw new Error(`${OPTIMIZER_LABEL} timed out. Try again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const poll = await resilientFetch(
      `${base}/predictions/${prediction.id}`,
      { method: "GET", headers },
      { label: OPTIMIZER_LABEL, retries: 2, timeoutMs: 20_000, baseDelayMs: 800 },
    );
    if (!poll.ok) continue;
    prediction = (await poll.json()) as typeof prediction;
  }

  if (prediction.status !== "succeeded") {
    throw new Error(
      `${OPTIMIZER_LABEL} failed: ${prediction.error ?? prediction.status ?? "unknown error"}`,
    );
  }

  const parsed = parseOptimizedStyleOutput(joinReplicateOutput(prediction.output));
  if (!parsed.stylePrompt) {
    throw new Error(`${OPTIMIZER_LABEL} returned an empty prompt.`);
  }
  return parsed;
}
