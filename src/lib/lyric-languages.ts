import { z } from "zod";

/** Target languages offered next to the Gemini Co-Producer buttons. */

export const LYRIC_LANGUAGES = [
  { value: "auto", label: "Auto / English (Default)", instruction: "English" },
  { value: "lt", label: "Lithuanian (Lietuvių)", instruction: "Lithuanian (Lietuvių)" },
  {
    value: "ng",
    label: "Nigerian (Pidgin / Afro-Fusion)",
    instruction: "Nigerian Pidgin with Afro-Fusion phrasing",
  },
  {
    value: "en-lt",
    label: "Bilingual (English + Lithuanian)",
    instruction: "Bilingual: English hooks with Lithuanian verses and ad-libs",
  },
  {
    value: "en-ng",
    label: "Bilingual (English + Nigerian Pidgin)",
    instruction: "Bilingual: English hooks with Nigerian Pidgin verses and ad-libs",
  },
  { value: "es", label: "Spanish (Español)", instruction: "Spanish (Español)" },
  { value: "custom", label: "Custom / Other", instruction: "" },
] as const;

export const VALID_LYRIC_LANGUAGE_VALUES = LYRIC_LANGUAGES.map((l) => l.value);

export type LyricLanguage = (typeof LYRIC_LANGUAGES)[number]["value"];

export const DEFAULT_LYRIC_LANGUAGE: LyricLanguage = "auto";

/** Zod schema to validate a lyric language value before it reaches the Gemini payload. */
export const lyricLanguageSchema = z.enum(VALID_LYRIC_LANGUAGE_VALUES as [LyricLanguage, ...LyricLanguage[]]);

/** Returns true if the value is one of the supported dropdown language options. */
export function isValidLyricLanguage(value: unknown): value is LyricLanguage {
  return lyricLanguageSchema.safeParse(value).success;
}

export function lyricLanguageLabel(value: string): string {
  return LYRIC_LANGUAGES.find((l) => l.value === value)?.label ?? "Auto / English (Default)";
}

/** Human-readable target language handed to Gemini. */
export function lyricLanguageInstruction(value: string, custom?: string): string {
  if (value === "custom") return custom?.trim() || "English";
  return LYRIC_LANGUAGES.find((l) => l.value === value)?.instruction || "English";
}
