/**
 * Curated, human-approved translations.
 *
 * Machine translation is good enough for body copy, but brand lines must be
 * exact. Entries here are seeded into the per-language cache on every run, so
 * they win over anything the service returned earlier (including bad values
 * already cached in a visitor's browser) while admin overrides still win over
 * them.
 */

export const TRANSLATION_GLOSSARY: Record<string, Record<string, string>> = {
  lt: {
    // Brand tagline — "Global impact" must read "pasaulinis poveikis".
    "Raw Words. Real Music. Global Impact.":
      "Tikri žodžiai. Tikra muzika. Pasaulinis poveikis.",
    "Raw Words. Real Music. Global Impact":
      "Tikri žodžiai. Tikra muzika. Pasaulinis poveikis",
    "Hybrid AI Records — Raw Words. Real Music. Global Impact.":
      "Hybrid AI Records — Tikri žodžiai. Tikra muzika. Pasaulinis poveikis.",
    "Raw Words. Real Music. Global Impact. Choose your production tier and start your project today.":
      "Tikri žodžiai. Tikra muzika. Pasaulinis poveikis. Pasirinkite gamybos paketą ir pradėkite savo projektą jau šiandien.",
    "Global Impact": "Pasaulinis poveikis",
    "Global impact": "pasaulinis poveikis",
    "global impact": "pasaulinis poveikis",
    "Raw Words": "Tikri žodžiai",
    "Real Music": "Tikra muzika",
  },
};

/** Seeds the curated phrases for `code` into a translation cache. */
export function applyGlossary(code: string, cache: Map<string, string>): void {
  const entries = TRANSLATION_GLOSSARY[code];
  if (!entries) return;
  for (const [source, translated] of Object.entries(entries)) {
    cache.set(source, translated);
  }
}
