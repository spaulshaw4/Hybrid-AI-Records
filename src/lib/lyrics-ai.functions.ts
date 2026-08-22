import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { LYRIC_LANGUAGES } from "@/lib/lyric-languages";
import { friendlyAiError } from "@/lib/ai-error";

const allowedLanguageInstructions = LYRIC_LANGUAGES.map((l) => l.instruction);

const Input = z.object({
  concept: z.string().trim().min(3).max(600),
  style: z.string().trim().max(2000).optional(),
  title: z.string().trim().max(120).optional(),
  language: z.union([z.enum(allowedLanguageInstructions as [string, ...string[]]), z.string().trim().max(120)]).optional(),
});

/**
 * Writes song lyrics through Google Interactions API (`GEMINI_API_KEY` + gemini-3.7-flash).
 */
export const generateLyrics = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }) => {
    console.log("[CO_PRODUCER]", {
      title: data.title ?? null,
      language: data.language ?? null,
      conceptLength: data.concept.length,
    });
    try {
      const { writeLyrics } = await import("./lyrics.server");
      const lyrics = await writeLyrics({
        concept: data.concept,
        style: data.style,
        title: data.title,
        language: data.language,
      });
      console.log("[CO_PRODUCER]", { lyricsLength: lyrics.length });
      return { lyrics };
    } catch (error) {
      console.error("[GEMINI_DIRECT_ERROR]", error);
      throw error instanceof Error ? error : new Error("Co-Producer Gemini request failed.");
    }
  });

const CoProducerInput = z.object({
  trackTitle: z.string().trim().max(120).optional(),
  language: z.string().trim().max(120).optional(),
});

/**
 * Step 1 Co-Producer — TanStack server function calling Gemini directly.
 * `@google/genai` stays inside the handler so it never ships to the browser.
 */
export const generateLyricsServerFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => CoProducerInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const { writeLyricsWithStudio } = await import("@/lib/coproducer");
    return writeLyricsWithStudio(data.trackTitle || "Untitled Track", data.language || "English");
  });


const ConceptInput = z.object({
  seed: z.string().trim().max(600).optional(),
  style: z.string().trim().max(2000).optional(),
  title: z.string().trim().max(120).optional(),
  language: z.union([z.enum(allowedLanguageInstructions as [string, ...string[]]), z.string().trim().max(120)]).optional(),
});

/** Writes or expands a song concept through the unified Replicate text engine. */
export const generateConcept = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => ConceptInput.parse(input))
  .handler(async ({ data }) => {
    try {
      const { writeConcept } = await import("./lyrics.server");
      const concept = await writeConcept({
        seed: data.seed,
        style: data.style,
        title: data.title,
        language: data.language,
      });
      return { concept };
    } catch (error) {
      console.error("[generateConcept]", error);
      throw friendlyAiError(error, "The concept writer");
    }
  });

const VocalPromptInput = z.object({
  concept: z.string().trim().min(3).max(600),
  lyrics: z.string().trim().max(2000).optional(),
  style: z.string().trim().max(2000).optional(),
  title: z.string().trim().max(120).optional(),
  language: z.union([z.enum(allowedLanguageInstructions as [string, ...string[]]), z.string().trim().max(120)]).optional(),
});

/** Writes a vocal performance prompt through the unified Replicate text engine. */
export const generateVocalPrompt = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => VocalPromptInput.parse(input))
  .handler(async ({ data }) => {
    try {
      const { writeVocalPrompt } = await import("./lyrics.server");
      const vocalPrompt = await writeVocalPrompt({
        concept: data.concept,
        lyrics: data.lyrics,
        style: data.style,
        title: data.title,
        language: data.language,
      });
      return { vocalPrompt };
    } catch (error) {
      console.error("[generateVocalPrompt]", error);
      throw friendlyAiError(error, "The vocal prompt writer");
    }
  });

const StyleTagsInput = z.object({
  concept: z.string().trim().min(3).max(600),
  lyrics: z.string().trim().max(2000).optional(),
  style: z.string().trim().max(2000).optional(),
  title: z.string().trim().max(120).optional(),
});

/** Writes production style tags through the unified Replicate text engine. */
export const generateStyleTags = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => StyleTagsInput.parse(input))
  .handler(async ({ data }) => {
    try {
      const { writeStyleTags } = await import("./lyrics.server");
      const styleTags = await writeStyleTags({
        concept: data.concept,
        lyrics: data.lyrics,
        style: data.style,
        title: data.title,
      });
      return { styleTags };
    } catch (error) {
      console.error("[generateStyleTags]", error);
      throw friendlyAiError(error, "The style writer");
    }
  });
