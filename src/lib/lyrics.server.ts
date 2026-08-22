import { GoogleGenAI } from "@google/genai";
import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiFastModel } from "@/lib/ai-provider.server";

/** Server-only lyric writer used by both the studio button and the engine fallback. */

/** Native Gemini Flash via GEMINI_API_KEY. Override with GEMINI_MODEL. */
export const COPRODUCER_GEMINI_MODEL =
  (typeof process !== "undefined" && process.env["GEMINI_MODEL"]?.trim()) || "gemini-2.5-flash";

export type LyricBrief = {
  concept: string;
  style?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
};

function geminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (!trimmed) {
    console.error("[GEMINI_DIRECT_ERROR]", "GEMINI_API_KEY is undefined — add it to .env.local");
    throw new Error("Missing GEMINI_API_KEY in .env.local");
  }
  return trimmed;
}

export async function writeLyrics(brief: LyricBrief): Promise<string> {
  geminiApiKey();
  const language = brief.language?.trim() || "English";
  const trackTitle = brief.title?.trim() || "Untitled";

  console.log("[CO_PRODUCER]", { trackTitle, language, model: COPRODUCER_GEMINI_MODEL });

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
    const response = await ai.models.generateContent({
      model: COPRODUCER_GEMINI_MODEL,
      contents: `Write complete song lyrics with [Verse], [Chorus], [Bridge], [Outro] in ${language} for a track titled "${trackTitle}".`,
      config: { maxOutputTokens: 8192 },
    });
    const lyrics = (response.text ?? "").trim();
    if (!lyrics || lyrics === "undefined" || lyrics === "null") {
      throw new Error("Co-Producer returned nothing. Try a richer brief.");
    }
    return lyrics;
  } catch (error) {
    console.error("[GEMINI_DIRECT_ERROR]", error);
    throw error instanceof Error ? error : new Error("Co-Producer Gemini request failed.");
  }
}

const CONCEPT_SYSTEM_PROMPT =
  "You are the Executive Co-Producer for Hybrid Engine 1.0. " +
  "Write a vivid one-paragraph song concept in English: the story, mood, setting and " +
  "emotional arc a producer could build a track from. If a target language is given, " +
  "note the intended language/dialect feel of the vocal delivery inside the paragraph. " +
  "60-90 words, no headings, no lists, no lyrics, no commentary. Return only the paragraph.";

/** Expands (or invents) a song concept for the studio's concept box. */
export async function writeConcept(brief: {
  seed?: string | undefined;
  style?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
}): Promise<string> {

  const prompt = [
    brief.seed ? `Starting idea: ${brief.seed}` : "Starting idea: surprise me with something original.",
    `Target language: ${brief.language?.trim() || "English"}`,
    brief.style ? `Style tags: ${brief.style}` : null,
    brief.title ? `Working title: ${brief.title}` : null,
  ]
    .filter(Boolean)
    .join("\n");


  const response = await aiChatFetch(
    // FREE Hybrid tier — never billed against the paid key.
    {
    body: JSON.stringify({
      model: aiFastModel(),
      messages: [
        { role: "system", content: CONCEPT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (response.status === 429) throw new Error("The concept writer is busy right now. Try again in a moment.");
  if (response.status === 402) throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Concept writer failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const concept = payload.choices?.[0]?.message?.content?.trim();
  if (!concept) throw new Error("The concept writer returned nothing. Try again.");
  return concept;
}

const VOCAL_PROMPT_SYSTEM_PROMPT =
  "You are the Vocal Director for Hybrid Engine 1.0. " +
  "Write a concise, vivid vocal performance prompt (20-50 words) describing the voice, delivery, tone, and production treatment. " +
  "Base it on the song concept, style, lyrics, and title. Be specific: gender/texture, emotion, ad-libs, effects, and attitude. " +
  "No commentary, no lists, no lyrics, no metatags. Return only the vocal prompt paragraph.";

/** Writes a vocal performance prompt for the studio's vocal prompt box. */
export async function writeVocalPrompt(brief: {
  concept: string;
  lyrics?: string | undefined;
  style?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
}): Promise<string> {

  const prompt = [
    `Concept: ${brief.concept}`,
    `Target language: ${brief.language?.trim() || "English"}`,
    brief.lyrics ? `Lyrics excerpt: ${brief.lyrics.slice(0, 400)}` : null,
    brief.style ? `Style tags: ${brief.style}` : null,
    brief.title ? `Working title: ${brief.title}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await aiChatFetch(
    // FREE Hybrid tier — never billed against the paid key.
    {
    body: JSON.stringify({
      model: aiFastModel(),
      messages: [
        { role: "system", content: VOCAL_PROMPT_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (response.status === 429) throw new Error("The vocal prompt writer is busy right now. Try again in a moment.");
  if (response.status === 402) throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vocal prompt writer failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const vocalPrompt = payload.choices?.[0]?.message?.content?.trim();
  if (!vocalPrompt) throw new Error("The vocal prompt writer returned nothing. Try a richer brief.");
  return vocalPrompt;
}

const STYLE_TAGS_SYSTEM_PROMPT =
  "You are the Style Director for Hybrid Engine 1.0. " +
  "Return a single comma-separated list of 5-9 production style tags describing genre, era, instrumentation, mix character and tempo feel. " +
  "Stay faithful to the brief and do not blend unrelated genres. " +
  "No commentary, no numbering, no quotes, no lyrics, no metatags. Return only the comma-separated tags.";

/** Writes comma-separated production style tags for the studio's custom style box. */
export async function writeStyleTags(brief: {
  concept: string;
  lyrics?: string | undefined;
  style?: string | undefined;
  title?: string | undefined;
}): Promise<string> {

  const prompt = [
    `Concept: ${brief.concept}`,
    brief.lyrics ? `Lyrics excerpt: ${brief.lyrics.slice(0, 400)}` : null,
    brief.style ? `Existing style tags: ${brief.style}` : null,
    brief.title ? `Working title: ${brief.title}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await aiChatFetch(
    // FREE Hybrid tier — never billed against the paid key.
    {
    body: JSON.stringify({
      model: aiFastModel(),
      messages: [
        { role: "system", content: STYLE_TAGS_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (response.status === 429) throw new Error("The style writer is busy right now. Try again in a moment.");
  if (response.status === 402) throw new Error("AI credits are exhausted. Add credits and try again.");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Style writer failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("The style writer returned nothing. Try a richer brief.");
  return raw
    .replace(/[\r\n]+/g, ", ")
    .replace(/["'`]/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^[-*\d.\s]+/, ""))
    .filter(Boolean)
    .slice(0, 9)
    .join(", ");
}
