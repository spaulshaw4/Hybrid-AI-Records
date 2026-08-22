/**
 * Replicate `elevenlabs/music` output formats.
 *
 * The hosted schema does not accept ElevenLabs' native codec strings such as
 * `mp3_44100_128`. Sending one of those returns a 422 and aborts the hybrid
 * intro before MiniMax/ACE-Step can finish.
 */

export const ELEVENLABS_MUSIC_OUTPUT_FORMATS = [
  "mp3_standard",
  "mp3_high_quality",
  "wav_16khz",
  "wav_22khz",
  "wav_24khz",
  "wav_cd_quality",
] as const;

export type ElevenLabsMusicOutputFormat = (typeof ELEVENLABS_MUSIC_OUTPUT_FORMATS)[number];

/** Maps the studio's mp3/wav toggle onto a format the Replicate model accepts. */
export function elevenLabsMusicOutputFormat(
  audioFormat?: "mp3" | "wav",
): ElevenLabsMusicOutputFormat {
  return audioFormat === "wav" ? "wav_cd_quality" : "mp3_high_quality";
}
