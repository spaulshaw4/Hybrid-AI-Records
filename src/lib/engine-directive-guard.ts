/**
 * Directive isolation guard.
 *
 * Invariant enforced here, for every render mode (vocal, auto-written lyrics,
 * instrumental):
 *   1. the phonetic / language directive IS present in the engine `prompt`
 *      whenever a non-English language profile is resolved, and
 *   2. the directive NEVER appears inside the `lyrics` stream — a leaked
 *      directive gets sung as literal words in the master.
 */

import { directiveForMode, type LanguageProfile } from "./engine-language";

export type DirectiveAudit = {
  directive: string;
  /** Directive expected in the prompt (non-English profile resolved). */
  expected: boolean;
  presentInPrompt: boolean;
  leakedIntoLyrics: boolean;
  violations: string[];
};

/** Sentences we never want sung, matched loosely so partial leaks are caught. */
function directiveFragments(directive: string): string[] {
  return directive
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

const DIRECTIVE_MARKERS = [
  /\bvocal delivery\s*:/i,
  /\bpronunciation\s*:/i,
  /\bdo not translate, transliterate/i,
  /\bsing every accented character\b/i,
  /\binstrumental only\s*:/i,
  /\bregional character\s*:/i,
  /\brhythmic feel\s*:/i,
  /\bphrasing\s*:/i,
];

export function auditDirectivePlacement(args: {
  prompt: string;
  lyrics: string;
  profile: LanguageProfile | null;
  instrumental: boolean;
}): DirectiveAudit {
  const { prompt, lyrics, profile, instrumental } = args;
  const directive = directiveForMode(profile, instrumental);
  const expected = directive.length > 0;
  const presentInPrompt = expected ? prompt.includes(directive) : false;

  const fragments = directiveFragments(directive);
  const leakedIntoLyrics =
    lyrics.length > 0 &&
    (fragments.some((f) => lyrics.includes(f)) || DIRECTIVE_MARKERS.some((re) => re.test(lyrics)));

  const violations: string[] = [];
  if (expected && !presentInPrompt) violations.push("directive missing from prompt");
  if (leakedIntoLyrics) violations.push("directive leaked into lyrics");
  if (instrumental && lyrics.trim().length > 0) violations.push("instrumental carries lyrics");

  return { directive, expected, presentInPrompt, leakedIntoLyrics, violations };
}

/** Removes any directive text that leaked into a lyric body. */
export function stripDirectiveFromLyrics(
  lyrics: string,
  profile: LanguageProfile | null,
  instrumental: boolean,
): string {
  const directive = directiveForMode(profile, instrumental);
  let out = lyrics;
  if (directive) {
    out = out.split(directive).join(" ");
    for (const fragment of directiveFragments(directive)) out = out.split(fragment).join(" ");
  }
  out = out
    .split("\n")
    .filter((line) => !DIRECTIVE_MARKERS.some((re) => re.test(line)))
    .join("\n");
  return out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
