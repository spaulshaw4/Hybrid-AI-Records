/**
 * Builds the Hybrid Engine style descriptor from the artist's exact request
 * fields. Genre-lock templates and slider defaults must not rewrite BPM,
 * genre, mood, instruments, or vocal style.
 */

import {
  logDynamicPayloadDispatch,
  serializeDynamicTags,
  type DynamicTagRequest,
} from "@/lib/engine-pipeline";

export type DynamicStylePromptInput = DynamicTagRequest & {
  /** @deprecated Prefer vocalStyle — kept so older callers still serialize. */
  vocalProfile?: string | null;
};

export { serializeDynamicTags, logDynamicPayloadDispatch };
export type { DynamicTagRequest };

function trimText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Comma-separated style tags for MiniMax `prompt` / ACE-Step `prompt`.
 * Lyrics stay in the dedicated lyrics field.
 */
export function buildDynamicStylePrompt(input: DynamicStylePromptInput): string {
  return serializeDynamicTags({
    genre: input.genre,
    subGenre: input.subGenre,
    mood: input.mood,
    bpm: input.bpm,
    instruments: input.instruments,
    vocalStyle: input.vocalStyle || input.vocalProfile,
  });
}

/** True when the string is already artist-authored style tags, not a genre lock. */
export function isDynamicStylePrompt(text: string | null | undefined): boolean {
  const value = trimText(text);
  if (!value) return false;
  return (
    /\[Style:/i.test(value) ||
    /\d+\s*BPM\b/i.test(value) ||
    /\bvocals?\b/i.test(value) ||
    /studio recording/i.test(value)
  );
}

/**
 * Joins style tags with lyrics for a single prompt field.
 * MiniMax / ACE-Step still keep lyrics on the dedicated lyrics key.
 */
export function concatStylePromptWithLyrics(
  stylePrompt?: string | null,
  lyrics?: string | null,
): string {
  return stylePrompt ? `${stylePrompt}\n\n${lyrics || ""}`.trim() : lyrics || "";
}

/** Logs the exact JSON posted to a music API (no audio bytes). */
export function logApiPayload(payload: unknown): void {
  console.log("[API_PAYLOAD]", JSON.stringify(payload, null, 2));
}
