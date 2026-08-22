/**
 * Turns a lyric brief into spoken/sung text for instant voice cloning.
 * Structure tags stay in the arrangement payload; the clone only needs words.
 */
export function lyricsForCloneSpeech(lyrics: string): string {
  return lyrics
    .replace(/^\s*\[[^\]]+\]\s*$/gm, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function languageHintForClone(language: string, customLanguage = ""): string {
  const code = language.trim().toLowerCase();
  if (code === "en" || code === "auto" || code === "") return "en";
  if (
    code === "es" ||
    code === "lt" ||
    code === "af" ||
    code === "fr" ||
    code === "de" ||
    code === "ja" ||
    code === "pt" ||
    code === "it" ||
    code === "sw"
  ) {
    return code;
  }
  if (code === "custom") {
    const custom = customLanguage.trim().toLowerCase();
    if (custom.startsWith("lt") || custom.includes("lithuan")) return "lt";
    if (custom.startsWith("es") || custom.includes("spanish")) return "es";
  }
  return "en";
}
