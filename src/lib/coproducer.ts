import { GoogleGenAI } from "@google/genai";

/** Google Interactions API model. Override with GEMINI_MODEL. */
export const COPRODUCER_GEMINI_MODEL =
  (typeof process !== "undefined" && process.env["GEMINI_MODEL"]?.trim()) || "gemini-3.7-flash";

export async function writeLyricsWithStudio(trackTitle: string, language: string) {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
  if (!apiKey) {
    // Vendor names must stay out of thrown copy: this message reaches the
    // studio as a toast. The env var is named on the lookup line above.
    throw new Error("The Co-Producer is not configured. Add the lyric engine API key to .env.local.");
  }
  const ai = new GoogleGenAI({ apiKey });
  try {
    const interaction = await ai.interactions.create({
      model: "gemini-3.7-flash",
      input: `You are an elite music co-producer. Write complete song lyrics in ${language || "English"} with section markers ([Verse], [Chorus], [Bridge], [Outro]) for a track titled "${trackTitle || "Untitled Track"}". Return only the lyrics.`,
    });
    return { lyrics: interaction.output_text || "" };
  } catch (error: unknown) {
    console.error("[STUDIO_INTERACTIONS_ERROR]", error);
    throw error;
  }
}

/** Alias used by engine callers and the Co-Producer HTTP route. */
export async function writeLyricsDirect(trackTitle: string, language: string) {
  return writeLyricsWithStudio(trackTitle, language);
}
