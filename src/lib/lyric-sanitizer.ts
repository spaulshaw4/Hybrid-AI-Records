/**
 * Lyric stream sanitiser.
 *
 * The engine sings whatever arrives in the `lyrics` field, so style tags,
 * instrumentation cues, production directions and non-structural metatags must
 * never reach it. This module strips everything that is not sung text while
 * preserving the structural section labels ([Verse 1], [Chorus], ...) MiniMax
 * uses for arrangement.
 */

/** Section labels the engine understands as structure, not as sung words. */
const STRUCTURAL_LABEL =
  /^(intro|verse|pre[- ]?chorus|chorus|hook|refrain|bridge|breakdown|drop|interlude|outro|end(ing)?)(\s*\d+)?$/i;

/** Words that mark a line/parenthetical as production direction, not lyrics. */
const PRODUCTION_WORDS = [
  "bpm", "tempo", "genre", "sub-genre", "subgenre", "style", "styles", "mood",
  "instrumentation", "instrument", "instruments", "guitar", "guitars", "drums",
  "drum", "bass", "808", "synth", "synths", "piano", "organ", "strings",
  "brass", "horns", "sax", "trumpet", "banjo", "fiddle", "pedal steel",
  "hi-hat", "hi-hats", "hats", "snare", "kick", "percussion", "reverb",
  "delay", "mix", "master", "mastering", "production", "produced",
  "arrangement", "solo", "riff", "riffs", "groove", "beat", "loop", "sample",
  "vocal", "vocals", "vocalist", "timbre", "delivery", "harmonies", "adlib",
  "ad-lib", "ad libs", "prompt", "tags", "key of", "time signature",
  "crossover", "instrumental",
];

const PRODUCTION_WORD_RE = new RegExp(
  `\\b(${PRODUCTION_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/** `Style:`-type metadata prefixes that are never sung. */
const METADATA_LINE =
  /^\s*(title|style|styles|prompt|genre|sub-?genre|mood|bpm|tempo|key|time signature|instruments?|instrumentation|vocals?|vocal style|production|mix|master|tags|notes?|description|language|artist|feat\.?)\s*[:\-–]\s*/i;

/** Normalises a bracket tag to a clean structural label, or null if it is not one. */
function normalizeBracketTag(inner: string): string | null {
  const cleaned = inner.trim().replace(/\s+/g, " ");
  if (!STRUCTURAL_LABEL.test(cleaned)) return null;
  const titled = cleaned
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_m, p, c: string) => `${p}${c.toUpperCase()}`);
  return `[${titled}]`;
}

/** Strips parentheticals that read as production directions (keeps ad-libs). */
function stripProductionParentheticals(line: string): string {
  return line
    .replace(/\(([^()]*)\)/g, (match, inner: string) =>
      PRODUCTION_WORD_RE.test(inner) ? " " : match,
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** True when a line is a bare style-tag list rather than a sung line. */
function isStyleTagLine(line: string): boolean {
  const commas = (line.match(/,/g) ?? []).length;
  if (commas < 2) return false;
  if (/[.!?]$/.test(line.trim())) return false;
  return PRODUCTION_WORD_RE.test(line);
}

/**
 * Removes every non-lyric artefact from the lyric stream:
 * metadata lines, style-tag lists, production parentheticals and any bracket
 * metatag that is not a structural section label.
 */
export function sanitizeLyricStream(lyrics: string): string {
  const lines: string[] = [];

  for (const raw of lyrics.replace(/\r\n?/g, "\n").split("\n")) {
    // Rewrite bracket tags: keep structural labels, drop everything else.
    let line = raw.replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
      const label = normalizeBracketTag(inner);
      return label ? `\u0000${label}\u0000` : " ";
    });
    line = line.replace(/\u0000/g, "");

    line = stripProductionParentheticals(line);
    if (METADATA_LINE.test(line)) continue;
    if (isStyleTagLine(line)) continue;

    lines.push(line.replace(/[ \t]+$/g, ""));
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}
