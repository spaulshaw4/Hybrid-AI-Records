/**
 * Universal language mapping for the MiniMax music engine.
 *
 * MiniMax reads one free-text `prompt` (style) and one `lyrics` stream. It has
 * no language field, so the *only* way to get native pronunciation is to (a)
 * hand it lyric text whose diacritics survived the round trip byte-for-byte and
 * (b) state the target language, its accent and its phonetic pitfalls inside
 * the style prompt. Without that, the model defaults to an American-English
 * reading of foreign words ("Lietuvos" sung as "Lee-eh-TOO-vos") and frequently
 * drops or mangles accented characters.
 *
 * This module is the single source of truth for both halves, for every
 * language — the picker's presets, anything the user types under "Custom", and
 * anything auto-detected from the lyrics themselves.
 */

/** What the engine needs to know to sing one language correctly. */
export type LanguageProfile = {
  /** Stable id — a lyric-language dropdown value or a detected ISO-ish code. */
  id: string;
  /** English name used in the prompt sentence. */
  name: string;
  /** Endonym, included so the model anchors on the native phonology. */
  native?: string;
  /** Accent / delivery instruction for the sung vocal. */
  accent: string;
  /** Language-specific pronunciation traps stated positively. */
  phonetics: string;
  /** Characters that must survive intact; empty when the script has no marks. */
  diacritics?: string;
  /** Extra grammar/prosody guidance (word stress, syllable timing, …). */
  prosody?: string;
  /** Set for blends: the secondary language woven through the song. */
  secondary?: string;
};

const P = (p: LanguageProfile) => p;

/**
 * Profiles keyed by language code AND by lyric-picker value, so `lt`, `en-lt`
 * and a detected Lithuanian lyric all resolve through the same entry.
 */
export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  en: P({
    id: "en",
    name: "English",
    accent: "natural North American English diction",
    phonetics: "clear consonant endings, unforced vowels",
    prosody: "stress-timed phrasing that follows the natural speech rhythm",
  }),
  lt: P({
    id: "lt",
    name: "Lithuanian",
    native: "lietuvių kalba",
    accent: "native Lithuanian pronunciation, no English or Slavic accent",
    phonetics:
      "pronounce č as 'ch', š as 'sh', ž as 'zh', j as 'y'; keep the long vowels ą ę į ų ū y long and pure; never anglicise Lithuanian words",
    diacritics: "ą č ę ė į š ų ū ž",
    prosody:
      "free lexical word stress kept where the language places it, with pitch accent on long syllables",
  }),
  ng: P({
    id: "ng",
    name: "Nigerian Pidgin",
    native: "Naija",
    accent: "authentic West African / Nigerian Pidgin delivery, Afro-fusion phrasing",
    phonetics:
      "clean open vowels, no schwa reduction, rolled or tapped r, syllable-final consonants voiced fully; never a generic American accent",
    prosody: "syllable-timed bounce that rides the percussion, melodic ad-libs between lines",
  }),
  es: P({
    id: "es",
    name: "Spanish",
    native: "español",
    accent: "native Spanish pronunciation",
    phonetics:
      "pure five-vowel system, tapped r and rolled rr, ñ as 'ny', silent h, no English diphthongisation",
    diacritics: "á é í ó ú ü ñ ¿ ¡",
    prosody: "syllable-timed delivery with stress on the accented syllable",
  }),
  pt: P({
    id: "pt",
    name: "Portuguese",
    native: "português",
    accent: "native Portuguese pronunciation",
    phonetics: "nasal vowels ã õ held nasal, ç as 's', lh as 'ly', nh as 'ny'",
    diacritics: "á â ã à é ê í ó ô õ ú ç",
  }),
  fr: P({
    id: "fr",
    name: "French",
    native: "français",
    accent: "native French pronunciation",
    phonetics: "nasal vowels, uvular r, silent final consonants, liaison between words",
    diacritics: "à â ç é è ê ë î ï ô ù û ü ÿ œ",
  }),
  de: P({
    id: "de",
    name: "German",
    native: "Deutsch",
    accent: "native German pronunciation",
    phonetics: "front-rounded ü ö, ch as the soft ich-laut or hard ach-laut, final devoicing",
    diacritics: "ä ö ü ß",
  }),
  it: P({
    id: "it",
    name: "Italian",
    native: "italiano",
    accent: "native Italian pronunciation",
    phonetics: "open pure vowels, doubled consonants held long, no vowel reduction",
    diacritics: "à è é ì ò ù",
  }),
  pl: P({
    id: "pl",
    name: "Polish",
    native: "polski",
    accent: "native Polish pronunciation",
    phonetics: "sz/cz/ż as retroflex, ł as 'w', ą ę nasal, penultimate word stress",
    diacritics: "ą ć ę ł ń ó ś ź ż",
  }),
  ru: P({
    id: "ru",
    name: "Russian",
    native: "русский",
    accent: "native Russian pronunciation",
    phonetics: "palatalised soft consonants, unstressed o reduced to 'a', rolled r",
    prosody: "single strong stress per word, vowels around it reduced",
  }),
  uk: P({
    id: "uk",
    name: "Ukrainian",
    native: "українська",
    accent: "native Ukrainian pronunciation",
    phonetics: "г as a voiced h, и as a mid vowel, і clear and front",
    diacritics: "і ї є ґ",
  }),
  tr: P({
    id: "tr",
    name: "Turkish",
    native: "Türkçe",
    accent: "native Turkish pronunciation",
    phonetics: "vowel harmony respected, ı unrounded, ğ lengthening the preceding vowel",
    diacritics: "ç ğ ı İ ö ş ü",
  }),
  ro: P({
    id: "ro",
    name: "Romanian",
    native: "română",
    accent: "native Romanian pronunciation",
    phonetics: "ă and â as central vowels, ș as 'sh', ț as 'ts'",
    diacritics: "ă â î ș ț",
  }),
  cs: P({
    id: "cs",
    name: "Czech",
    native: "čeština",
    accent: "native Czech pronunciation",
    phonetics: "ř as the raised trill, háček consonants palatalised, first-syllable stress",
    diacritics: "á č ď é ě í ň ó ř š ť ú ů ý ž",
  }),
  sv: P({
    id: "sv",
    name: "Swedish",
    native: "svenska",
    accent: "native Swedish pronunciation",
    phonetics: "pitch accent across two tones, sj-sound, long/short vowel contrast",
    diacritics: "å ä ö",
  }),
  nl: P({
    id: "nl",
    name: "Dutch",
    native: "Nederlands",
    accent: "native Dutch pronunciation",
    phonetics: "guttural g, diphthongs ij/ui/eu kept distinct",
    diacritics: "é ë ï ó ü",
  }),
  ar: P({
    id: "ar",
    name: "Arabic",
    native: "العربية",
    accent: "native Arabic pronunciation with melismatic Arabic vocal ornamentation",
    phonetics: "emphatic consonants, glottal stop, ʿayn and ḥa articulated from the throat",
    prosody: "right-to-left text sung in written order, quarter-tone inflections allowed",
  }),
  hi: P({
    id: "hi",
    name: "Hindi",
    native: "हिन्दी",
    accent: "native Hindi pronunciation",
    phonetics: "retroflex ट ड ण, aspirated/unaspirated pairs kept distinct, nasalised vowels",
  }),
  zh: P({
    id: "zh",
    name: "Mandarin Chinese",
    native: "中文",
    accent: "native Mandarin pronunciation",
    phonetics: "lexical tones preserved inside the melody, retroflex zh/ch/sh, clean finals",
  }),
  ja: P({
    id: "ja",
    name: "Japanese",
    native: "日本語",
    accent: "native Japanese pronunciation",
    phonetics: "mora-timed syllables, pure short vowels, pitch-accent patterns",
  }),
  ko: P({
    id: "ko",
    name: "Korean",
    native: "한국어",
    accent: "native Korean pronunciation",
    phonetics: "tense/aspirated consonant contrasts, final consonants unreleased",
  }),
};

/** Blended options from the lyric-language picker. */
const BLENDS: Record<string, { primary: string; secondary: string; note: string }> = {
  "en-lt": {
    primary: "en",
    secondary: "lt",
    note: "English hooks with Lithuanian verses and ad-libs",
  },
  "en-ng": {
    primary: "en",
    secondary: "ng",
    note: "English hooks with Nigerian Pidgin verses and ad-libs",
  },
};

/* ── Script / diacritic detection ──────────────────────────────────────────
 * Used when the picker says "auto", and as a cross-check when it doesn't: if
 * the user selected English but pasted Lithuanian lyrics, the lyrics win. */

const SCRIPT_SIGNATURES: Array<[string, RegExp]> = [
  // Kana before Han: Japanese text mixes kanji with kana, Chinese never has kana.
  ["ja", /[\u3040-\u30ff]/],
  ["ko", /[\uac00-\ud7af]/],
  ["zh", /[\u4e00-\u9fff]/],
  ["ar", /[\u0600-\u06ff]/],
  ["hi", /[\u0900-\u097f]/],
  ["uk", /[іїєґІЇЄҐ]/],
  ["ru", /[\u0400-\u04ff]/],
];

/**
 * Letters that belong to exactly one of our languages. Checked first, because
 * the broader signatures below overlap heavily (ž is Lithuanian *and* Czech,
 * ö is Swedish *and* German, â is French *and* Romanian).
 */
const UNIQUE_LATIN_SIGNATURES: Array<[string, RegExp]> = [
  ["cs", /[ěřůďťň]/i],
  ["tr", /[ğışİ]/],
  ["ro", /[șț]/i],
  ["pl", /[łńśź]/i],
  ["lt", /[ėįūų]/i],
  ["sv", /å/i],
  ["de", /[üß]/i],
  ["es", /[ñ¿¡]/i],
  ["pt", /[ãõ]/i],
  ["fr", /[àèëïùûœ]/i],
];

const LATIN_SIGNATURES: Array<[string, RegExp]> = [
  ["lt", /[ąčęšųūž]/i],
  ["pl", /[ąćęż]/i],
  ["ro", /[ă]/i],
  ["sv", /[äö]/i],
  ["de", /[äö]/i],
  ["pt", /ç/i],
  ["fr", /[âçêîô]/i],
  ["it", /\b(che|perché|sono|amore)\b/i],
];

/** Best-effort language code for a lyric body, or null when it reads as English. */
export function detectLyricLanguage(lyrics: string): string | null {
  const text = lyrics.normalize("NFC");
  if (!text.trim()) return null;
  for (const [code, re] of SCRIPT_SIGNATURES) if (re.test(text)) return code;
  for (const [code, re] of UNIQUE_LATIN_SIGNATURES) if (re.test(text)) return code;
  for (const [code, re] of LATIN_SIGNATURES) if (re.test(text)) return code;
  return null;

}

/* ── Encoding safety ─────────────────────────────────────────────────────── */

/** UTF-8 bytes that were decoded as Latin-1 somewhere upstream (ą → Ä…). */
const MOJIBAKE = /[ÃÄÅÐ][\u0080-\u00bf\u2013-\u203a\s]/;

/**
 * Makes a lyric body safe to put on the wire without losing a single accent:
 * composes combining marks into single code points (NFC — the form MiniMax's
 * tokenizer expects), repairs Latin-1 mojibake, and removes invisible
 * characters that otherwise become audible glitches or split a word in two.
 */
export function normalizeLyricUnicode(text: string): string {
  let out = text;

  if (MOJIBAKE.test(out)) {
    // Re-decode: each char below U+0100 is one original UTF-8 byte.
    try {
      const bytes = Uint8Array.from([...out].map((c) => c.charCodeAt(0) & 0xff));
      const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (repaired && !MOJIBAKE.test(repaired)) out = repaired;
    } catch {
      /* Not recoverable as UTF-8 — keep the original text. */
    }
  }

  return out
    .normalize("NFC")
    // Zero-width + BOM + word joiner: invisible, but they break tokenisation.
    .replace(/[\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, "")
    // Non-breaking / narrow spaces read as unknown glyphs; make them spaces.
    .replace(/[\u00a0\u202f\u2007]/g, " ")
    // Typographic punctuation the tokenizer handles worse than ASCII.
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");
}

/* ── Prompt injection ────────────────────────────────────────────────────── */

/** Resolves a picker value (+ optional custom text + lyrics) to a profile. */
export function resolveLanguageProfile(
  selected: string | undefined,
  customLanguage: string | undefined,
  lyrics = "",
): LanguageProfile | null {
  const detected = detectLyricLanguage(lyrics);

  const blend = selected ? BLENDS[selected] : undefined;
  if (blend) {
    const primary = LANGUAGE_PROFILES[blend.primary];
    const secondary = LANGUAGE_PROFILES[blend.secondary];
    return {
      ...primary,
      id: selected!,
      name: `${primary.name} and ${secondary.name}`,
      accent: `${blend.note}; ${secondary.accent}`,
      phonetics: secondary.phonetics,
      diacritics: secondary.diacritics,
      prosody: secondary.prosody,
      secondary: secondary.name,
    };
  }

  if (selected === "custom") {
    const label = customLanguage?.trim();
    if (label) {
      // A custom entry may still be a language we have a full profile for.
      const known = Object.values(LANGUAGE_PROFILES).find(
        (p) =>
          p.name.toLowerCase() === label.toLowerCase() ||
          p.native?.toLowerCase() === label.toLowerCase(),
      );
      if (known) return known;
      return {
        id: "custom",
        name: label,
        accent: `native ${label} pronunciation and accent`,
        phonetics: `every ${label} word pronounced as a native speaker would, never anglicised`,
        prosody: `natural ${label} word stress and syllable timing`,
      };
    }
  }

  if (selected && selected !== "auto" && LANGUAGE_PROFILES[selected]) {
    // Selection wins, unless the lyrics are plainly in another language.
    if (detected && detected !== selected && LANGUAGE_PROFILES[detected]) {
      return LANGUAGE_PROFILES[detected];
    }
    return LANGUAGE_PROFILES[selected];
  }

  // "auto" / unset: follow the lyrics. English needs no special handling.
  return detected ? (LANGUAGE_PROFILES[detected] ?? null) : null;
}

/**
 * The sentence block appended to the engine `prompt`. Everything here is style
 * guidance — no lyric text ever crosses into it, so nothing added here can be
 * sung aloud as prompt text.
 */
export function buildLanguageDirective(profile: LanguageProfile | null): string {
  if (!profile || profile.id === "en") return "";

  const name = profile.native ? `${profile.name} (${profile.native})` : profile.name;
  const parts = [
    `Lyrics are written and sung entirely in ${name}.`,
    `Vocal delivery: ${profile.accent}.`,
    `Pronunciation: ${profile.phonetics}.`,
  ];
  if (profile.diacritics) {
    parts.push(
      `Sing every accented character exactly as written (${profile.diacritics}) — never substitute the unaccented letter or spell the word out.`,
    );
  }
  if (profile.prosody) parts.push(`Phrasing: ${profile.prosody}.`);
  parts.push(
    `Do not translate, transliterate, romanise or re-order the lyrics, and do not add an English accent.`,
  );
  return parts.join(" ");
}

/**
 * Appends the language directive to a style prompt, once, within the engine's
 * 6000-character `prompt` budget.
 */
export function applyLanguageToPrompt(prompt: string, profile: LanguageProfile | null): string {
  const directive = buildLanguageDirective(profile);
  if (!directive) return prompt;
  if (prompt.includes(directive)) return prompt;
  return `${prompt.trim()} ${directive}`.replace(/\s{2,}/g, " ").slice(0, 6000);
}

/**
 * Instrumental variant of the language directive. An instrumental has no vocal
 * to accent, so the phonetic guidance is re-cast as regional musical character
 * plus a hard no-vocals constraint. Kept in the `prompt` only — like the vocal
 * directive, it must never leak into the lyrics stream.
 */
export function buildInstrumentalLanguageDirective(profile: LanguageProfile | null): string {
  if (!profile || profile.id === "en") return "";
  const name = profile.native ? `${profile.name} (${profile.native})` : profile.name;
  const parts = [
    `Instrumental only: no vocals, no lyrics, no vocal samples or spoken words.`,
    `Regional character: ${name} musical phrasing and instrumentation.`,
  ];
  if (profile.prosody) parts.push(`Rhythmic feel: ${profile.prosody}.`);
  return parts.join(" ");
}

/** The directive that belongs in `prompt` for this render mode. */
export function directiveForMode(profile: LanguageProfile | null, instrumental: boolean): string {
  return instrumental
    ? buildInstrumentalLanguageDirective(profile)
    : buildLanguageDirective(profile);
}

/** Appends the mode-appropriate directive to a style prompt, once. */
export function applyDirectiveToPrompt(
  prompt: string,
  profile: LanguageProfile | null,
  instrumental: boolean,
): string {
  const directive = directiveForMode(profile, instrumental);
  if (!directive) return prompt;
  if (prompt.includes(directive)) return prompt;
  return `${prompt.trim()} ${directive}`.replace(/\s{2,}/g, " ").slice(0, 6000);
}
