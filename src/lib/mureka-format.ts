const SECTION_LINE = /^\[(verse|chorus|bridge|outro)(?:\s+\d+)?\]$/i;

function formatInstTags(lyrics: string): string {
  const withNearbyDuration = lyrics.replace(
    /\[(inst|instrumental)\](\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)\b)/gi,
    (_full, _kind, _gap, seconds: string) =>
      Number(seconds) > 10 ? "[inst-medium]" : "[inst-short]",
  );
  return withNearbyDuration.replace(/\[([^\]\n]+)\]/g, (full, rawInner: string) => {
    const inner = rawInner.trim().toLowerCase();
    if (inner === "inst-short" || inner === "inst-medium") return full;
    const tagged = inner.match(
      /^(inst|instrumental)(?:[\s:-]+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?)?$/,
    );
    if (!tagged) return full;
    if (tagged[2] !== undefined && Number(tagged[2]) > 10) return "[inst-medium]";
    return "[inst-short]";
  });
}

/** Section tags get one blank line. Bare [inst] becomes a duration tag. */
export function formatMurekaLyrics(lyrics: string): string {
  const lines = formatInstTags(lyrics.replace(/\r\n/g, "\n")).split("\n");
  const out: string[] = [];
  let started = false;
  let pendingBlank = false;

  for (const line of lines) {
    if (line.trim() === "") {
      if (started) pendingBlank = true;
      continue;
    }
    const section = SECTION_LINE.test(line.trim());
    if (started && (section || pendingBlank)) out.push("");
    out.push(line.replace(/[ \t]+$/g, ""));
    started = true;
    pendingBlank = false;
  }
  return out.join("\n");
}

function hasBpmFigure(text: string): boolean {
  return /\b\d+(?:\.\d+)?\s*bpm\b/i.test(text) || /\bbpm\s*[:=]?\s*\d+(?:\.\d+)?\b/i.test(text);
}

/**
 * Normalize comma spacing and append "{n} BPM" when bpm is passed and the
 * text has no BPM figure. User words stay as written.
 */
export function formatMurekaPrompt(prompt: string, bpm?: number): string {
  const text = prompt
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, ", ")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(", ");

  let formatted = text;
  if (typeof bpm === "number" && Number.isFinite(bpm) && !hasBpmFigure(formatted)) {
    const figure = Number.isInteger(bpm) ? String(bpm) : String(bpm);
    formatted = formatted ? `${formatted}, ${figure} BPM` : `${figure} BPM`;
  }
  return formatted.replace(/\b(\d+(?:\.\d+)?)\s*bpm\b/gi, "$1 BPM");
}
