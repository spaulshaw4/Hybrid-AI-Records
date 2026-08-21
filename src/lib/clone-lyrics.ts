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
  if (language === "lt") return "lt";
  if (language === "es") return "es";
  if (language === "custom") {
    const custom = customLanguage.trim().toLowerCase();
    if (custom.startsWith("lt") || custom.includes("lithuan")) return "lt";
    if (custom.startsWith("es") || custom.includes("spanish")) return "es";
  }
  return "en";
}
