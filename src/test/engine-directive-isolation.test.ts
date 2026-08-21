/**
 * Automated invariant check: the phonetic / language directive must always be
 * present in the engine `prompt`, and must never appear inside the `lyrics`
 * stream — for vocal renders, auto-written lyrics, and instrumentals alike.
 */
import { describe, expect, it } from "vitest";

import { auditDirectivePlacement, stripDirectiveFromLyrics } from "@/lib/engine-directive-guard";
import { directiveForMode, resolveLanguageProfile } from "@/lib/engine-language";
import { buildEnginePayloadPreview } from "@/lib/engine-payload";
import { buildMiniMaxPayload } from "@/lib/minimax-payload";

const CASES = [
  { lang: "lt", lyrics: "Aš einu per naktį, žvaigždės dega ugnimi" },
  { lang: "es", lyrics: "Corro por la calle, el corazón no perdona" },
  { lang: "ja", lyrics: "夜の街を歩く、心は静かに燃える" },
  { lang: "ar", lyrics: "أمشي في الليل والنجوم تحترق" },
  { lang: "pl", lyrics: "Idę przez miasto, gdzie światła gasną" },
];

describe("directive isolation — vocal renders", () => {
  for (const { lang, lyrics } of CASES) {
    it(`${lang}: directive in prompt, absent from lyrics`, () => {
      const payload = buildMiniMaxPayload({
        prompt: "dark trap, 140 bpm, gritty",
        lyrics,
        language: lang,
      });
      const profile = resolveLanguageProfile(lang, undefined, lyrics);
      const directive = directiveForMode(profile, false);

      expect(directive.length).toBeGreaterThan(0);
      expect(payload.input.prompt).toContain(directive);
      expect(payload.input.lyrics).toBeTruthy();
      expect(payload.input.lyrics).not.toContain(directive);

      const audit = auditDirectivePlacement({
        prompt: payload.input.prompt,
        lyrics: payload.input.lyrics ?? "",
        profile,
        instrumental: false,
      });
      expect(audit.violations).toEqual([]);
      expect(audit.presentInPrompt).toBe(true);
      expect(audit.leakedIntoLyrics).toBe(false);
    });
  }
});

describe("directive isolation — instrumentals", () => {
  for (const { lang, lyrics } of CASES) {
    it(`${lang}: instrumental directive in prompt, no lyrics stream`, () => {
      const payload = buildMiniMaxPayload({
        prompt: "cinematic drill instrumental",
        lyrics,
        language: lang,
        instrumental: true,
      });
      const profile = resolveLanguageProfile(lang, undefined, lyrics);
      const directive = directiveForMode(profile, true);

      expect(directive).toMatch(/Instrumental only/);
      expect(payload.input.prompt).toContain(directive);
      expect(payload.input.is_instrumental).toBe(true);
      expect(payload.input.lyrics ?? "").toBe("");

      const audit = auditDirectivePlacement({
        prompt: payload.input.prompt,
        lyrics: payload.input.lyrics ?? "",
        profile,
        instrumental: true,
      });
      expect(audit.violations).toEqual([]);
    });
  }
});

describe("directive isolation — auto-written lyrics that echo the brief", () => {
  it("scrubs a directive the lyric writer copied into its output", () => {
    const lang = "lt";
    const profile = resolveLanguageProfile(lang, undefined, "žvaigždės");
    const directive = directiveForMode(profile, false);
    // Simulates Gemini repeating its own instructions back inside the lyrics.
    const polluted = `${directive}\n\n[Verse]\nAš einu per naktį\n\n[Chorus]\nŽvaigždės dega`;

    const cleaned = stripDirectiveFromLyrics(polluted, profile, false);
    expect(cleaned).not.toContain(directive);
    expect(cleaned).toContain("Aš einu per naktį");
    expect(cleaned).toContain("[Verse]");

    const payload = buildMiniMaxPayload({
      prompt: "melodic drill",
      lyrics: polluted,
      language: lang,
    });
    expect(payload.input.prompt).toContain(directive);
    expect(payload.input.lyrics).not.toContain(directive);
    expect(payload.input.lyrics).not.toMatch(/Pronunciation:|Vocal delivery:/i);

    const audit = auditDirectivePlacement({
      prompt: payload.input.prompt,
      lyrics: payload.input.lyrics ?? "",
      profile,
      instrumental: false,
    });
    expect(audit.violations).toEqual([]);
  });

  it("catches a partial directive fragment leaking into lyrics", () => {
    const profile = resolveLanguageProfile("es", undefined, "corazón");
    const audit = auditDirectivePlacement({
      prompt: "reggaeton " + directiveForMode(profile, false),
      lyrics: "[Verse]\nPronunciation: rolled rr\nCorro por la calle",
      profile,
      instrumental: false,
    });
    expect(audit.leakedIntoLyrics).toBe(true);
    expect(audit.violations).toContain("directive leaked into lyrics");
  });

  it("flags a prompt that dropped the directive", () => {
    const profile = resolveLanguageProfile("lt", undefined, "žvaigždės");
    const audit = auditDirectivePlacement({
      prompt: "dark trap, 140 bpm",
      lyrics: "Aš einu per naktį",
      profile,
      instrumental: false,
    });
    expect(audit.violations).toContain("directive missing from prompt");
  });
});

describe("directive isolation — studio payload preview", () => {
  it("matches the wire invariant for vocal and instrumental previews", () => {
    for (const instrumental of [false, true]) {
      const preview = buildEnginePayloadPreview(
        "hard drill, 145 bpm",
        "Aš einu per naktį, žvaigždės dega",
        instrumental,
        "mp3",
        { selected: "lt" },
      );
      const profile = resolveLanguageProfile("lt", undefined, "žvaigždės dega");
      const directive = directiveForMode(profile, instrumental);
      expect(preview.input.prompt).toContain(directive);
      expect(preview.input.lyrics).not.toContain(directive);
      const audit = auditDirectivePlacement({
        prompt: preview.input.prompt,
        lyrics: preview.input.lyrics,
        profile,
        instrumental,
      });
      expect(audit.violations).toEqual([]);
    }
  });

  it("English needs no directive and reports no violation", () => {
    const payload = buildMiniMaxPayload({
      prompt: "boom bap",
      lyrics: "I walk the night alone",
      language: "en",
    });
    const profile = resolveLanguageProfile("en", undefined, "I walk the night alone");
    const audit = auditDirectivePlacement({
      prompt: payload.input.prompt,
      lyrics: payload.input.lyrics ?? "",
      profile,
      instrumental: false,
    });
    expect(audit.expected).toBe(false);
    expect(audit.violations).toEqual([]);
  });
});
