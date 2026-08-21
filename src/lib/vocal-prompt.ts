/**
 * Vocal enforcement helpers for the /studio generation path.
 * Every generation is a sung, full-vocal master — never an instrumental.
 */

import { buildGenreLockedPrompt, detectGenre } from "./genre-lock";
import { sanitizeLyricStream } from "./lyric-sanitizer";

const INSTRUMENTAL_TERMS = [
  "instrumental only",
  "instrumentals",
  "instrumental",
  "backing track",
  "backing-track",
  "beat only",
  "beat-only",
  "no vocals",
  "no vocal",
  "without vocals",
  "vocal free",
  "vocal-free",
  "karaoke",
];

export const VOCAL_TAGS = [
  "lead male vocal",
  "raspy delivery",
  "sung melody",
  "vocal performance",
];

/** Removes instrumental/no-vocal phrasing so MiniMax never drops the vocal. */
export function stripInstrumentalTerms(text: string): string {
  let out = text;
  for (const term of INSTRUMENTAL_TERMS) {
    out = out.replace(new RegExp(`\\b${term.replace(/[-\\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "gi"), " ");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

/** Appends the vocal tags that aren't already present in the style prompt. */
export function appendVocalTags(style: string): string {
  const base = stripInstrumentalTerms(style);
  const lower = base.toLowerCase();
  const missing = VOCAL_TAGS.filter((tag) => !lower.includes(tag));
  return [base, ...missing].filter(Boolean).join(", ");
}

const SECTION_TAG = /^\s*\[[^\]]+\]\s*$/;
const DEFAULT_SECTIONS = ["[Verse 1]", "[Chorus]", "[Verse 2]", "[Outro]"];

/**
 * Guarantees the lyric payload is wrapped in structural brackets and contains
 * nothing but sung text. Style tags, instrumentation cues and non-structural
 * metatags are stripped first so the engine can never sing prompt text aloud.
 */
export function structureLyrics(lyrics: string): string {
  const text = sanitizeLyricStream(stripInstrumentalTerms(lyrics)).trim();
  if (!text) return "";
  if (text.split("\n").some((line) => SECTION_TAG.test(line))) return text;


  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) return "";

  return blocks
    .map((block, i) => `${DEFAULT_SECTIONS[i] ?? `[Verse ${i + 1}]`}\n${block}`)
    .join("\n\n");
}

export const REQUIRED_LYRIC_SECTIONS = DEFAULT_SECTIONS;

/**
 * Returns the required bracket sections missing from the lyrics, in order.
 * Matching is case-insensitive and tolerant of extra spacing ("[ verse 1 ]").
 */
export function missingLyricSections(lyrics: string): string[] {
  const found = new Set(
    (lyrics.match(/\[[^\]]+\]/g) ?? []).map((t) =>
      t.slice(1, -1).trim().toLowerCase().replace(/\s+/g, " "),
    ),
  );
  return REQUIRED_LYRIC_SECTIONS.filter(
    (s) => !found.has(s.slice(1, -1).toLowerCase()),
  );
}

/** Tags MiniMax leans on by default; dropped when the user asked for another genre. */
const GENERIC_ENGINE_TAGS = ["electronic", "electronica", "synth", "synths", "synthesizer", "techno", "edm", "dance beat"];

/** The vocal override prepended to every engine prompt payload. */
export const VOCAL_OVERRIDE_TAGS = ["lead vocal performance", "sung melody", "vocal track"];

function hasTag(text: string, tag: string): boolean {
  return new RegExp(`\\b${tag.replace(/[-\\/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i").test(text);
}

/**
 * Removes generic electronic defaults when the detected style is not an
 * electronic one (country, reggae, rock, hip-hop, …). Tags the user typed
 * themselves are always kept.
 */
export function enforceGenre(style: string, userRequested = style): string {
  const rule = detectGenre(style);
  if (!rule || rule.electronic) return style;
  let out = style;
  for (const tag of GENERIC_ENGINE_TAGS) {
    if (hasTag(userRequested, tag) && userRequested !== style) continue;
    out = out.replace(new RegExp(`\\b${tag}\\b`, "gi"), " ");
  }
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}


/**
 * Builds the `prompt` payload parameter.
 *
 * The raw style tags are reformatted into the fixed descriptive sentence
 * ("A [Mood] [Genre] song. [Vocal Style] vocals. Strictly traditional
 * [Genre] instrumentation. No crossover elements from other genres.") plus the
 * genre's negative constraints, because MiniMax blends genres when it is fed
 * loose tags. Lyric text never enters this string.
 */
export function buildEnginePrompt(style: string, fallbackBrief = ""): string {
  const base = stripInstrumentalTerms(style) || stripInstrumentalTerms(fallbackBrief);
  const enforced = enforceGenre(base);
  return buildGenreLockedPrompt(enforced).slice(0, 6000);
}

/** Instrumental variant: same genre lock, with the vocal clause removed. */
export function buildInstrumentalEnginePrompt(style: string, fallbackBrief = ""): string {
  const locked = buildGenreLockedPrompt(
    enforceGenre(stripInstrumentalTerms(style) || stripInstrumentalTerms(fallbackBrief)),
  ).replace(/\s*[^.]*\bvocals\.\s*/i, " ");
  return [locked.trim(), "Instrumental backing track, no vocals."]
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 6000);
}
