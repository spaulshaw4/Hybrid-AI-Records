import { z } from "zod";

/** Target languages offered in the Hybrid Engine Step 1 picker. */

export const LYRIC_LANGUAGES = [
  { value: "en", label: "English", instruction: "English" },
  { value: "es", label: "Spanish (Español)", instruction: "Spanish (Español)" },
  { value: "lt", label: "Lithuanian (Lietuvių)", instruction: "Lithuanian (Lietuvių)" },
  { value: "af", label: "Afrikaans", instruction: "Afrikaans" },
  { value: "fr", label: "French (Français)", instruction: "French (Français)" },
  { value: "de", label: "German (Deutsch)", instruction: "German (Deutsch)" },
  { value: "ja", label: "Japanese (日本語)", instruction: "Japanese (日本語)" },
  { value: "pt", label: "Portuguese (Português)", instruction: "Portuguese (Português)" },
  { value: "it", label: "Italian (Italiano)", instruction: "Italian (Italiano)" },
  { value: "sw", label: "Swahili (Kiswahili)", instruction: "Swahili (Kiswahili)" },
] as const;

export const VALID_LYRIC_LANGUAGE_VALUES = LYRIC_LANGUAGES.map((l) => l.value);

export type LyricLanguage = (typeof LYRIC_LANGUAGES)[number]["value"];

export const DEFAULT_LYRIC_LANGUAGE: LyricLanguage = "en";

/** Zod schema to validate a lyric language value before it reaches the Gemini payload. */
export const lyricLanguageSchema = z.enum(VALID_LYRIC_LANGUAGE_VALUES as [LyricLanguage, ...LyricLanguage[]]);

/**
 * Form/API field: missing or legacy picker values (`auto`, `custom`, …) fall
 * back to English so the form is never in an empty invalid state.
 */
export const lyricLanguageFieldSchema = lyricLanguageSchema
  .default(DEFAULT_LYRIC_LANGUAGE)
  .catch(DEFAULT_LYRIC_LANGUAGE);

/** Returns true if the value is one of the supported dropdown language options. */
export function isValidLyricLanguage(value: unknown): value is LyricLanguage {
  return lyricLanguageSchema.safeParse(value).success;
}

export function lyricLanguageLabel(value: string): string {
  return LYRIC_LANGUAGES.find((l) => l.value === value)?.label ?? "English";
}

/** Human-readable target language handed to Gemini. */
export function lyricLanguageInstruction(value: string, custom?: string): string {
  return LYRIC_LANGUAGES.find((l) => l.value === value)?.instruction || custom?.trim() || "English";
}

/** Step 1 may continue only when title, lyrics, and a language are all set. */
export function isStudioStep1Complete(input: {
  title: string;
  lyrics: string;
  language: string;
}): boolean {
  return Boolean(input.title.trim() && input.lyrics.trim() && isValidLyricLanguage(input.language));
}
