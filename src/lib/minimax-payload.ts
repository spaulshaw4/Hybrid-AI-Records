/**
 * Universal engine-level MiniMax payload builder.
 *
 * The direct MiniMax API shape (model, positivePrompt, lyrics, settings) is
 * adapted here to the Replicate-compatible `minimax/music-2.6` input shape the
 * app uses through the Lovable connector gateway. The language/encoding logic
 * from the provided integration snippet is folded into the existing
 * `engine-language` engine so every supported language gets the same robust
 * phonetic, diacritic and accent handling.
 */

import { AudioFormat } from "./engine-payload";
import { stripDirectiveFromLyrics } from "./engine-directive-guard";
import {
  directiveForMode,
  normalizeLyricUnicode,
  resolveLanguageProfile,
} from "./engine-language";


export interface GenerationRequestPayload {
  prompt: string;
  lyrics: string;
  language?: string;
  /** Free-text language when the picker is set to "custom". */
  customLanguage?: string;
  /** Optional genre hint; treated as part of the prompt when present. */
  genre?: string;
  instrumental?: boolean;
  audioFormat?: AudioFormat;
}

export interface MiniMaxPayload {
  /** Wire body sent to the Replicate connector gateway. */
  input: {
    prompt: string;
    lyrics?: string;
    is_instrumental: boolean;
    lyrics_optimizer: true;
    audio_format: AudioFormat;
  };
  /**
   * Internal rendering metadata. Not sent to the model directly — these are
   * kept for logs, health checks, and any future direct-MiniMax migration.
   */
  settings: {
    sample_rate: 44100;
    bitrate: 256000;
    instrumental: boolean;
    timeout_seconds: 240;
  };
}

export function buildMiniMaxPayload(req: GenerationRequestPayload): MiniMaxPayload {
  const instrumental = req.instrumental === true;
  const audioFormat = req.audioFormat === "wav" ? "wav" : "mp3";

  // Repair encoding first: mojibake lyrics ("Å¾odis") would otherwise be
  // detected as the wrong language and lose their accents on the wire.
  const cleanLyrics = normalizeLyricUnicode(req.lyrics ?? "");

  // Resolve language from the picker, custom text, or the lyrics themselves.
  const profile = resolveLanguageProfile(req.language, req.customLanguage, cleanLyrics);

  // Build the mode-appropriate directive (vocal phonetics, or the no-vocals
  // instrumental variant) so diacritics and accent survive the generation.
  const directive = directiveForMode(profile, instrumental);

  // Merge the supplied prompt with any genre hint, then append the directive.
  const basePrompt = [req.prompt.trim(), req.genre?.trim()].filter(Boolean).join(" ").trim();
  const prompt = [basePrompt, basePrompt.includes(directive) ? "" : directive]
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .slice(0, 6000);

  // The directive is style guidance: it must never reach the lyrics stream,
  // or the model sings it out loud.
  const lyrics = instrumental ? "" : stripDirectiveFromLyrics(cleanLyrics, profile, instrumental);


  return {
    input: {
      ...(instrumental ? {} : { lyrics }),
      prompt,
      is_instrumental: instrumental,
      lyrics_optimizer: true,
      audio_format: audioFormat,
    },
    settings: {
      sample_rate: 44100,
      bitrate: 256000,
      instrumental,
      timeout_seconds: 240,
    },
  };
}
