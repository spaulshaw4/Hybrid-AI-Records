/**
 * Mirrors the exact `minimax/music-2.6` request body the server sends, so the
 * Studio can show a developer-visible payload preview before generating.
 * Keep in sync with requestApiframeGeneration() in apiframe.server.ts.
 */
import {
  buildEnginePrompt,
  buildInstrumentalEnginePrompt,
  stripInstrumentalTerms,
  structureLyrics,
} from "./vocal-prompt";
import { stripDirectiveFromLyrics } from "./engine-directive-guard";
import {
  applyDirectiveToPrompt,
  normalizeLyricUnicode,
  resolveLanguageProfile,
} from "./engine-language";
import { isDynamicStylePrompt } from "./generation-style-prompt";

export type AudioFormat = "mp3" | "wav";

export const ENGINE_MODEL = "hybrid-core/music-2.6";

export type EnginePayloadPreview = {
  model: string;
  input: {
    prompt: string;
    lyrics: string;
    is_instrumental: boolean;
    lyrics_optimizer: true;
    audio_format: AudioFormat;
  };
};

/**
 * @param stylePrompt merged style + BPM + vocal traits (engine `prompt`)
 * @param lyrics raw lyric text from the form (engine `lyrics`)
 */
export function buildEnginePayloadPreview(
  stylePrompt: string,
  lyrics: string,
  instrumental = false,
  audioFormat: AudioFormat = "mp3",
  language?: { selected?: string; custom?: string },
): EnginePayloadPreview {
  const clean = stripInstrumentalTerms(stylePrompt);
  const safeLyrics = normalizeLyricUnicode(lyrics);
  // Same resolution the server performs, so the preview shows the real prompt.
  const profile = resolveLanguageProfile(language?.selected, language?.custom, safeLyrics);
  const preserve = isDynamicStylePrompt(stylePrompt);
  const basePrompt = preserve
    ? clean
    : instrumental
      ? buildInstrumentalEnginePrompt(clean, clean)
      : buildEnginePrompt(clean, clean);
  return {
    model: ENGINE_MODEL,
    input: {
      prompt: applyDirectiveToPrompt(basePrompt, profile, instrumental),
      lyrics: instrumental
        ? ""
        : stripDirectiveFromLyrics(
            normalizeLyricUnicode(structureLyrics(safeLyrics)),
            profile,
            instrumental,
          ),
      is_instrumental: instrumental,
      lyrics_optimizer: true,
      audio_format: audioFormat,
    },
  };
}

/** Live endpoint the server posts the generation request to. */
export const ENGINE_ENDPOINT =
  "https://api.replicate.com/v1/models/minimax/music-2.6/predictions";

/**
 * Headers the server sends. Secrets are never exposed to the browser, so the
 * cURL uses shell variables you fill in locally.
 */
export const ENGINE_CURL_HEADERS: Array<[string, string]> = [
  ["Content-Type", "application/json"],
  ["Accept", "application/json"],
  ["Authorization", "Bearer $REPLICATE_API_KEY"],
  ["X-Correlation-Id", "curl-debug"],
];

/** Exact wire body: the endpoint is model-scoped, so only `input` is sent. */
export function buildEngineRequestBody(
  stylePrompt: string,
  lyrics: string,
  instrumental = false,
  audioFormat: AudioFormat = "mp3",
  language?: { selected?: string; custom?: string },
) {
  const { input } = buildEnginePayloadPreview(
    stylePrompt,
    lyrics,
    instrumental,
    audioFormat,
    language,
  );
  return { input };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Copy-pasteable cURL reproducing the exact minimax/music-2.6 request. */
export function buildEngineCurl(
  stylePrompt: string,
  lyrics: string,
  instrumental = false,
  audioFormat: AudioFormat = "mp3",
  language?: { selected?: string; custom?: string },
): string {
  const body = JSON.stringify(
    buildEngineRequestBody(stylePrompt, lyrics, instrumental, audioFormat, language),
    null,
    2,
  );
  const headerLines = ENGINE_CURL_HEADERS.map(([k, v]) => `  -H ${shellQuote(`${k}: ${v}`)} \\`);
  return [
    `curl -X POST ${shellQuote(ENGINE_ENDPOINT)} \\`,
    ...headerLines,
    `  -d ${shellQuote(body)}`,
  ].join("\n");
}
