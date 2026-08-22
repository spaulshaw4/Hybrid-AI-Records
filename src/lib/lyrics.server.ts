import { aiChatFetch } from "@/lib/ai-chat.server";
import { aiFastModel } from "@/lib/ai-provider.server";
import { REPLICATE_GEMINI_MODEL, replicateChat } from "@/lib/replicate-llm.server";

/** Server-only lyric writer used by both the studio button and the engine fallback. */

export const COPRODUCER_GEMINI_MODEL = REPLICATE_GEMINI_MODEL;

export type LyricBrief = {
  concept: string;
  style?: string | undefined;
  title?: string | undefined;
  language?: string | undefined;
};

function coProducerSystemPrompt(language: string, trackTitle: string): string {
  return (
    `You are an expert music lyricist and co-producer. Write full, structured song lyrics in ${language} ` +
    `(with [Verse], [Chorus], [Bridge], [Outro] tags) for a song titled '${trackTitle}'. ` +
    `Maintain rhythmic cadence and authentic phrasing in ${language}. ` +
    `Return only the lyrics, no commentary. Never copy existing songs.`
  );
}

export async function writeLyrics(brief: LyricBrief): Promise<string> {
  const language = brief.language?.trim() || "English";
  const trackTitle = brief.title?.trim() || "Untitled";
  const genre = brief.style?.trim() || "";
  const user = [
    `Language: ${language}`,
    `Title: ${trackTitle}`,
    genre ? `Genre / style: ${genre}` : null,
    brief.concept.trim() ? `Brief / existing lyrics:\n${brief.concept.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const lyrics = await replicateChat(
    [
      { role: "system", content: coProducerSystemPrompt(language, trackTitle) },
      { role: "user", content: user },
    ],
    {
      label: "Co-Producer",
      model: COPRODUCER_GEMINI_MODEL,
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 120_000,
    },
  );
  if (!lyrics) throw new Error("Co-Producer returned nothing. Try a richer brief.");
  return lyrics;
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
