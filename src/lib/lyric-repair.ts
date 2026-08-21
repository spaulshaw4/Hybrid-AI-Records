/**
 * Best-effort repair for Gemini lyric output with malformed bracketed metatags.
 *
 * Gemini occasionally returns section tags like `[Verse 1`, `(Chorus)`, `**Verse**`
 * or `[[Hook]]`. Rather than dropping the response, we normalise what we can and
 * surface a warning so the user knows the structure was cleaned automatically.
 */

const KNOWN_SECTIONS = [
  "intro",
  "verse",
  "pre-chorus",
  "prechorus",
  "chorus",
  "hook",
  "post-chorus",
  "bridge",
  "refrain",
  "breakdown",
  "drop",
  "interlude",
  "instrumental",
  "solo",
  "outro",
  "ad-lib",
  "adlib",
];

function titleCaseSection(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
        .join("-"),
    )
    .join(" ");
}

function looksLikeSection(raw: string): boolean {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "");
  if (!cleaned || cleaned.length > 40) return false;
  return KNOWN_SECTIONS.some((section) => cleaned.startsWith(section));
}

export interface LyricRepairResult {
  /** Cleaned lyrics, safe to drop straight into the lyrics field. */
  lyrics: string;
  /** True when we had to fix or normalise anything. */
  repaired: boolean;
  /** Human readable notes about what was cleaned. */
  warnings: string[];
}

/**
 * Normalise lyric text so every section header is a single `[Section]` tag on its own line.
 */
export function repairLyricStructure(input: string): LyricRepairResult {
  const warnings: string[] = [];
  const original = input ?? "";
  let text = original.replace(/\r\n/g, "\n").trim();

  if (!text) {
    return { lyrics: "", repaired: false, warnings: [] };
  }

  // Strip markdown code fences Gemini sometimes wraps output in.
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    text = fenced[1].trim();
    warnings.push("Removed markdown code fences.");
  }

  // Collapse doubled brackets: [[Chorus]] -> [Chorus]
  if (/\[\[|\]\]/.test(text)) {
    text = text.replace(/\[+/g, "[").replace(/\]+/g, "]");
    warnings.push("Collapsed duplicated brackets in section tags.");
  }

  // Drop bold/italic markers around tags: **[Verse]** or **Verse**
  if (/\*\*?/.test(text)) {
    text = text.replace(/\*+/g, "");
    warnings.push("Removed markdown emphasis characters.");
  }

  const lines = text.split("\n");
  let fixedTags = 0;
  let convertedTags = 0;

  const output = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return "";

    // Already a well formed tag.
    const wellFormed = line.match(/^\[([^\[\]]+)\]$/);
    if (wellFormed) {
      return `[${titleCaseSection(wellFormed[1])}]`;
    }

    // Unclosed / unopened bracket: "[Verse 1" or "Verse 1]"
    const unbalanced = line.match(/^\[([^\[\]]+)$/) ?? line.match(/^([^\[\]]+)\]$/);
    if (unbalanced && looksLikeSection(unbalanced[1])) {
      fixedTags += 1;
      return `[${titleCaseSection(unbalanced[1])}]`;
    }

    // Parenthesised or colon-suffixed headers: "(Chorus)" / "Chorus:" / "## Verse 2"
    const alt =
      line.match(/^\(([^()]+)\)$/) ??
      line.match(/^#{1,6}\s*(.+)$/) ??
      line.match(/^(.+?)\s*:$/);
    if (alt && looksLikeSection(alt[1])) {
      convertedTags += 1;
      return `[${titleCaseSection(alt[1])}]`;
    }

    // Inline stray tag remnants inside a lyric line.
    return line.replace(/\[([^\[\]]*)$/, "$1").replace(/^([^\[\]]*)\]/, "$1");
  });

  if (fixedTags > 0) {
    warnings.push(`Repaired ${fixedTags} unbalanced section tag${fixedTags === 1 ? "" : "s"}.`);
  }
  if (convertedTags > 0) {
    warnings.push(
      `Converted ${convertedTags} section header${convertedTags === 1 ? "" : "s"} to [Bracket] format.`,
    );
  }

  let cleaned = output.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // If nothing resembling a structure survived, add a minimal scaffold.
  if (!/\[[^\[\]]+\]/.test(cleaned)) {
    cleaned = `[Verse]\n${cleaned}`;
    warnings.push("No section tags found — added a [Verse] tag so the engine can shape structure.");
  }

  return {
    lyrics: cleaned,
    repaired: warnings.length > 0 || cleaned !== original.trim(),
    warnings,
  };
}
