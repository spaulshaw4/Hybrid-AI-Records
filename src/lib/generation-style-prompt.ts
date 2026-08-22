/**
 * Builds the Hybrid Engine style prompt from the artist's exact request
 * fields. Genre-lock templates and slider defaults must not rewrite BPM,
 * genre, mood, instruments, or vocal profile.
 */

export type DynamicStylePromptInput = {
  genre?: string | null;
  bpm?: number | null;
  mood?: string | null;
  instruments?: string[] | null;
  vocalProfile?: string | null;
};

function trimText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanInstruments(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item.trim()).filter(Boolean);
}

function exactBpm(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * `[Style: …] [Tempo: … BPM] [Mood: …] [Instruments: …]` from request fields.
 * Empty optional tags are omitted so we never invent a default mood or kit.
 */
export function buildDynamicStylePrompt(input: DynamicStylePromptInput): string {
  const genre = trimText(input.genre);
  const bpm = exactBpm(input.bpm);
  const mood = trimText(input.mood);
  const instruments = cleanInstruments(input.instruments);
  const vocalProfile = trimText(input.vocalProfile);

  const parts: string[] = [];
  if (genre) parts.push(`[Style: ${genre}]`);
  if (bpm != null) parts.push(`[Tempo: ${bpm} BPM]`);
  if (mood) parts.push(`[Mood: ${mood}]`);
  if (instruments.length) parts.push(`[Instruments: ${instruments.join(", ")}]`);
  if (vocalProfile) parts.push(`[Vocals: ${vocalProfile}]`);
  return parts.join(" ");
}

/** True when the prompt already carries the artist's Style/Tempo tags. */
export function isDynamicStylePrompt(text: string | null | undefined): boolean {
  const value = trimText(text);
  return /\[Style:/i.test(value) && /\[Tempo:/i.test(value);
}

/** Concatenates style metadata with lyrics for the generation API payload. */
export function concatStylePromptWithLyrics(stylePrompt: string, lyrics: string): string {
  const style = trimText(stylePrompt);
  const words = trimText(lyrics);
  if (!style) return words;
  if (!words) return style;
  return `${style}\n\n${words}`;
}

/** Logs the exact JSON posted to a music API (no audio bytes). */
export function logApiPayload(payload: unknown): void {
  console.log("[API_PAYLOAD]", JSON.stringify(payload, null, 2));
}
