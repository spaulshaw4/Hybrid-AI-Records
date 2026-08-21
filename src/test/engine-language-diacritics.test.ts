/**
 * Diacritic / mojibake / phonetic-trap coverage for the universal language
 * engine and the MiniMax payload builder.
 *
 * Every sample here is written the way a real user pastes it: NFD lyrics from
 * macOS, Latin-1 mojibake from a bad clipboard round trip, smart quotes from
 * Word, and language-specific traps (nasal vowels, tapped rr, ł as 'w', ř).
 */

import { describe, expect, it } from "vitest";
import {
  LANGUAGE_PROFILES,
  buildLanguageDirective,
  detectLyricLanguage,
  normalizeLyricUnicode,
  resolveLanguageProfile,
} from "@/lib/engine-language";
import { buildMiniMaxPayload } from "@/lib/minimax-payload";

/** UTF-8 text decoded as Latin-1 — the classic "Å¾" instead of "ž". */
const toMojibake = (text: string) =>
  Array.from(new TextEncoder().encode(text))
    .map((b) => String.fromCharCode(b))
    .join("");

describe("normalizeLyricUnicode — NFC cleanup", () => {
  it("composes NFD sequences into single code points", () => {
    const nfd = "z\u030Cin\u0328gsnis"; // ž + ǫ-style combining ogonek
    const out = normalizeLyricUnicode(nfd);
    expect(out).toBe(nfd.normalize("NFC"));
    expect(out).toContain("ž");
    expect(out.normalize("NFC")).toBe(out);
  });

  it("is idempotent on already-clean text", () => {
    const clean = "Širdis plaka lėtai";
    expect(normalizeLyricUnicode(normalizeLyricUnicode(clean))).toBe(clean);
  });

  it("strips invisible characters that break tokenisation", () => {
    const dirty = "\ufeffžai\u200bdimas\u2060 baigėsi\u200e";
    expect(normalizeLyricUnicode(dirty)).toBe("žaidimas baigėsi");
  });

  it("normalises exotic spaces and typographic punctuation to ASCII", () => {
    const dirty = "don\u2019t\u00a0stop \u201cnow\u201d \u2013 ever\u2026";
    expect(normalizeLyricUnicode(dirty)).toBe('don\'t stop "now" - ever...');
  });

  it("keeps non-Latin scripts untouched", () => {
    for (const sample of ["日本語の歌", "한국어 노래", "أغنية عربية", "गीत हिन्दी"]) {
      expect(normalizeLyricUnicode(sample)).toBe(sample);
    }
  });
});

describe("normalizeLyricUnicode — mojibake repair", () => {
  const samples: Array<[string, string]> = [
    ["Lithuanian", "Žiema užšalo, širdis ąžuolinė"],
    ["Polish", "Łódź gęsto, świeci źle"],
    ["Spanish", "El corazón añora, ¿por qué?"],
    ["Portuguese", "Coração não pára, canção"],
    ["French", "Où es-tu, mon âme, très tôt"],
    ["German", "Grüße über die Straße, schön"],
    ["Czech", "Řeka běží, přítel můj"],
    ["Romanian", "Înțeleg să știu, făr-ă"],
    ["Turkish", "Işık göğe düştü, çağır"],
    ["Swedish", "Här går vägen över ån"],
  ];

  for (const [name, original] of samples) {
    it(`repairs ${name} mojibake back to the original text`, () => {
      const broken = toMojibake(original);
      expect(broken).not.toBe(original);
      expect(normalizeLyricUnicode(broken)).toBe(original.normalize("NFC"));
    });
  }

  it("repairs the canonical Å¾ → ž case", () => {
    expect(normalizeLyricUnicode("Å¾odis")).toBe("žodis");
  });

  it("leaves legitimate Latin-1 text that is not mojibake alone", () => {
    const legit = "Über allen Gipfeln ist Ruh";
    expect(normalizeLyricUnicode(legit)).toBe(legit);
  });

  it("does not corrupt text when the byte sequence is not valid UTF-8", () => {
    const notRecoverable = "Ã\u00ff broken";
    expect(normalizeLyricUnicode(notRecoverable)).toBe(notRecoverable);
  });
});

describe("detectLyricLanguage", () => {
  const cases: Array<[string, string]> = [
    ["lt", "Ąžuolo šešėlyje ūžia vėjas"],
    ["pl", "Łąka gęsta, świeci źdźbło"],
    ["cs", "Řeka běží přes můj sen"],
    ["tr", "Işıklar söndü, gökyüzü ağır"],
    ["ro", "Știu că înțelegi această cale"],
    ["sv", "Vägen går över ån och ängen"],
    ["de", "Die Straße führt über grüne Höfe"],
    ["es", "¿Dónde está el corazón, niña?"],
    ["pt", "A canção não é uma ilusão"],
    ["fr", "Où çà, mon âme très fière"],
    ["ru", "Сердце бьётся в тишине"],
    ["uk", "Її серце співає ґанок"],
    ["zh", "我的心在燃烧"],
    ["ja", "夜のうたを歌う"],
    ["ko", "밤의 노래를 부른다"],
    ["ar", "قلبي ينبض في الليل"],
    ["hi", "दिल धड़कता है रात में"],
  ];

  for (const [code, lyrics] of cases) {
    it(`detects ${code}`, () => {
      expect(detectLyricLanguage(lyrics)).toBe(code);
    });
  }

  it("returns null for plain English and empty input", () => {
    expect(detectLyricLanguage("The night runs cold and long")).toBeNull();
    expect(detectLyricLanguage("   ")).toBeNull();
  });

  it("detects through NFD input", () => {
    expect(detectLyricLanguage("z\u030Cinia u\u0328z\u030Csalo")).toBe("lt");
  });

  it("separates Lithuanian from Polish on shared ą/ę", () => {
    expect(detectLyricLanguage("kęsti ir ūžti")).toBe("lt");
    expect(detectLyricLanguage("gęsto i łzy")).toBe("pl");
  });
});

describe("resolveLanguageProfile", () => {
  it("honours an explicit picker selection", () => {
    expect(resolveLanguageProfile("es", undefined, "")?.id).toBe("es");
  });

  it("lets clearly foreign lyrics override a mismatched selection", () => {
    expect(resolveLanguageProfile("en", undefined, "Ąžuolas ūžia")?.id).toBe("lt");
  });

  it("auto-resolves from the lyrics", () => {
    expect(resolveLanguageProfile("auto", undefined, "Coração não pára")?.id).toBe("pt");
    expect(resolveLanguageProfile("auto", undefined, "Plain English line")).toBeNull();
  });

  it("resolves mojibake lyrics once they are normalised", () => {
    const broken = toMojibake("Ąžuolas ūžia");
    expect(resolveLanguageProfile("auto", undefined, normalizeLyricUnicode(broken))?.id).toBe("lt");
  });

  it("maps a custom label onto a known profile by name or endonym", () => {
    expect(resolveLanguageProfile("custom", "Lithuanian", "")?.id).toBe("lt");
    expect(resolveLanguageProfile("custom", "lietuvių kalba", "")?.id).toBe("lt");
  });

  it("synthesises a profile for an unknown custom language", () => {
    const p = resolveLanguageProfile("custom", "Yoruba", "");
    expect(p?.id).toBe("custom");
    expect(p?.name).toBe("Yoruba");
    expect(p?.phonetics).toContain("Yoruba");
  });

  it("builds blended profiles with the secondary language's phonetics", () => {
    const p = resolveLanguageProfile("en-lt", undefined, "");
    expect(p?.name).toBe("English and Lithuanian");
    expect(p?.secondary).toBe("Lithuanian");
    expect(p?.diacritics).toBe(LANGUAGE_PROFILES.lt.diacritics);
  });
});

describe("phonetic traps are stated for every supported language", () => {
  const traps: Array<[string, RegExp]> = [
    ["lt", /ž as 'zh'/],
    ["es", /tapped r and rolled rr/],
    ["pt", /nasal vowels/i],
    ["fr", /nasal vowels/i],
    ["pl", /ł as 'w'/],
    ["cs", /ř/],
    ["tr", /vowel harmony/i],
    ["ro", /ț as 'ts'/],
    ["de", /front-rounded/i],
    ["ng", /rolled or tapped r/],
    ["zh", /tones/i],
    ["ja", /mora-timed/i],
    ["ar", /glottal stop/i],
    ["hi", /retroflex/i],
  ];

  for (const [code, re] of traps) {
    it(`${code} names its trap`, () => {
      expect(LANGUAGE_PROFILES[code].phonetics).toMatch(re);
    });
  }

  it("every profile carries an accent and phonetics line", () => {
    for (const [code, p] of Object.entries(LANGUAGE_PROFILES)) {
      expect(p.id, code).toBe(code);
      expect(p.accent.length, code).toBeGreaterThan(8);
      expect(p.phonetics.length, code).toBeGreaterThan(8);
    }
  });

  it("declared diacritics are real accented characters", () => {
    for (const [code, p] of Object.entries(LANGUAGE_PROFILES)) {
      if (!p.diacritics) continue;
      expect(p.diacritics.normalize("NFC"), code).toBe(p.diacritics);
      expect(p.diacritics, code).toMatch(/[^\x00-\x7F]/);
    }
  });
});

describe("buildLanguageDirective", () => {
  it("is empty for English and for no profile", () => {
    expect(buildLanguageDirective(null)).toBe("");
    expect(buildLanguageDirective(LANGUAGE_PROFILES.en)).toBe("");
  });

  it("names the language, accent, phonetics and diacritics", () => {
    const d = buildLanguageDirective(LANGUAGE_PROFILES.lt);
    expect(d).toContain("Lithuanian (lietuvių kalba)");
    expect(d).toContain("ž as 'zh'");
    expect(d).toContain("ą č ę ė į š ų ū ž");
    expect(d).toContain("Do not translate");
  });

  it("produces a non-empty directive for every non-English profile", () => {
    for (const [code, p] of Object.entries(LANGUAGE_PROFILES)) {
      if (code === "en") continue;
      expect(buildLanguageDirective(p).length, code).toBeGreaterThan(40);
    }
  });
});

describe("integration: buildMiniMaxPayload with tricky input", () => {
  it("repairs mojibake lyrics and injects the matching directive", () => {
    const payload = buildMiniMaxPayload({
      prompt: "Dark alternative rock",
      lyrics: toMojibake("Ąžuolas ūžia, širdis plaka"),
      language: "auto",
    });
    expect(payload.input.lyrics).toBe("Ąžuolas ūžia, širdis plaka");
    expect(payload.input.prompt).toContain("Lithuanian");
    expect(payload.input.prompt).toContain("ž as 'zh'");
  });

  it("keeps Spanish tapped-rr guidance and NFC-clean lyrics", () => {
    const payload = buildMiniMaxPayload({
      prompt: "Latin pop",
      lyrics: "El corazo\u0301n corre, perro rrrapido",
      language: "es",
    });
    expect(payload.input.lyrics).toContain("corazón");
    expect(payload.input.prompt).toContain("tapped r and rolled rr");
  });

  it("keeps Portuguese nasalisation guidance", () => {
    const payload = buildMiniMaxPayload({
      prompt: "Bossa",
      lyrics: "Corac\u0327a\u0303o na\u0303o pa\u0301ra",
      language: "pt",
    });
    expect(payload.input.lyrics).toBe("Coração não pára");
    expect(payload.input.prompt).toMatch(/nasal vowels/i);
  });

  it("adds no directive for English and the no-vocals directive for instrumentals", () => {
    const en = buildMiniMaxPayload({ prompt: "Rock", lyrics: "Just words", language: "en" });
    expect(en.input.prompt).toBe("Rock");

    const inst = buildMiniMaxPayload({
      prompt: "Rock",
      lyrics: "Ąžuolas ūžia",
      language: "lt",
      instrumental: true,
    });
    expect(inst.input.prompt).toContain("Instrumental only");
    expect(inst.input.prompt).not.toContain("Pronunciation:");
    expect(inst.input.lyrics).toBeUndefined();
  });

  it("carries a directive for every supported language end to end", () => {
    for (const code of Object.keys(LANGUAGE_PROFILES)) {
      if (code === "en") continue;
      const payload = buildMiniMaxPayload({
        prompt: "Cinematic",
        lyrics: "line one",
        language: code,
      });
      expect(payload.input.prompt, code).toContain(LANGUAGE_PROFILES[code].name);
      expect(payload.input.prompt.length, code).toBeLessThanOrEqual(6000);
    }
  });
});
