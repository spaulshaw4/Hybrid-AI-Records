/**
 * Vendor-name audit.
 *
 * The label is white-labeled: no page may reveal which third-party model or
 * provider powers a feature. These helpers are shared by the static source
 * audit (src/test/vendor-audit.test.ts) and the rendered-DOM audit
 * (e2e/vendor-copy-audit.spec.ts).
 */

/** Provider / model names that must never reach a user-visible surface. */
export const VENDOR_TERMS = [
  "minimax",
  "elevenlabs",
  "eleven labs",
  "suno",
  "udio",
  "gemini",
  "openai",
  "chatgpt",
  "gpt-4",
  "gpt-5",
  "anthropic",
  "claude",
  "veo 3",
  "veo3",
  "sora",
  "runway",
  "apiframe",
  "replicate",
  "kling",
  "stability ai",
  "midjourney",
] as const;

export type VendorLeak = { term: string; excerpt: string };

/** Words that legitimately contain a vendor term but are ordinary English. */
const ALLOWED_PHRASES = [
  "replicate, clone",
  "unlawfully replicate",
  "replicate the",
  "replicated",
];

function isAllowed(lowerHaystack: string, index: number): boolean {
  return ALLOWED_PHRASES.some((phrase) => {
    const start = Math.max(0, index - phrase.length);
    return lowerHaystack.slice(start, index + phrase.length).includes(phrase);
  });
}

/** Find every vendor term inside an arbitrary piece of user-visible text. */
export function findVendorLeaks(text: string): VendorLeak[] {
  const lower = text.toLowerCase();
  const leaks: VendorLeak[] = [];
  for (const term of VENDOR_TERMS) {
    let from = 0;
    for (;;) {
      const index = lower.indexOf(term, from);
      if (index === -1) break;
      from = index + term.length;
      const before = lower[index - 1] ?? " ";
      const after = lower[index + term.length] ?? " ";
      // Ignore matches glued inside a longer identifier-ish token.
      if (/[a-z0-9]/.test(before)) continue;
      if (/[a-z0-9]/.test(after) && !term.includes(" ")) {
        // allow plural / possessive style suffixes only
        if (!/^[.,!?)\s]/.test(after)) continue;
      }
      if (isAllowed(lower, index)) continue;
      leaks.push({
        term,
        excerpt: text.slice(Math.max(0, index - 60), index + term.length + 60).trim(),
      });
    }
  }
  return leaks;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Pull the strings a user could actually read out of a TSX source file:
 * JSX text nodes plus multi-word string literals (labels, toasts, copy).
 * Bare identifier-style literals ("minimax", "elevenlabs") are engine ids the
 * browser never displays, so they are intentionally ignored.
 */
export function extractUserFacingText(source: string): string[] {
  const body = stripComments(source)
    .split("\n")
    .filter((line) => !/^\s*import\s/.test(line) && !/from\s+["'@]/.test(line))
    .join("\n");

  const out: string[] = [];

  // JSX text nodes. Anything containing code punctuation is an expression
  // fragment, not prose the visitor reads.
  for (const match of body.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1]?.replace(/\s+/g, " ").trim() ?? "";
    if (!/[a-zA-Z]{3}/.test(text)) continue;
    if (/[=;()[\]&|`$]|=>|\+\+/.test(text)) continue;
    out.push(text);
  }

  // Copy inside string literals (labels, toasts, aria text). Interpolations
  // hold identifiers, so drop them before matching.
  for (const match of body.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g)) {
    const text = (match[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    if (!/\s/.test(text)) continue; // identifier / id / path, never rendered
    if (!/[a-zA-Z]{3}/.test(text)) continue;
    out.push(text.replace(/\s+/g, " ").trim());
  }

  return out;
}

/** True when a source path is server-only and therefore exempt. */
export function isServerOnlyPath(path: string): boolean {
  return (
    /\.server\.[jt]sx?$/.test(path) ||
    path.includes("/routes/api/") ||
    path.includes("/test/") ||
    path.includes("/e2e/") ||
    path.endsWith("/lib/vendor-audit.ts")
  );
}
