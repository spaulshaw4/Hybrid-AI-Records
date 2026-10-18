/**
 * Video shot script (server only).
 *
 * One Replicate call: Claude 3.5 Sonnet writes the shot list for the video
 * studio. Flux, Hailuo, Seedance, and VEED stay on WaveSpeed.
 */

import { replicateChat } from "@/lib/replicate-llm.server";
import { parseDirectedShotList, type DirectedShot } from "@/lib/cinematic-script-director";

export const SCRIPT_DIRECTOR_MODEL = "anthropic/claude-3.5-sonnet";
export const SCRIPT_DIRECTOR_MAX_TOKENS = 4000;
export const SCRIPT_DIRECTOR_TEMPERATURE = 0.7;

export type TimelineMarker = {
  label: "verse" | "chorus" | "bridge" | "drop";
  start: number;
  end: number;
};

const SYSTEM_PROMPT = [
  "You direct one music video.",
  "Reply with ONLY a JSON array. No markdown fences, no prose, no wrapper object.",
  "Each item must have exactly these fields:",
  "timestamp_start (number, seconds), timestamp_end (number, seconds),",
  "scene_type (short string), prompt_flux (one still-image sentence),",
  "motion_prompt (one moving-camera sentence for that same shot).",
  "Cover the timeline markers in order. Keep each shot between 4 and 10 seconds.",
  "Do not name cameras brands, model ids, or render vendors.",
].join(" ");

function markerLines(markers: TimelineMarker[]): string {
  if (!markers.length) return "No timeline markers were supplied.";
  return markers
    .map((marker) => `${marker.label} ${marker.start.toFixed(2)}-${marker.end.toFixed(2)}`)
    .join("\n");
}

/** Asks Claude for the shot list and refuses anything that is not a JSON list. */
export async function directVideoShotList(input: {
  lyrics: string;
  genre: string;
  styleDirection: string;
  markers: TimelineMarker[];
  characterDescription: string;
}): Promise<DirectedShot[]> {
  const lyrics = input.lyrics.trim() || "No lyrics were provided.";
  const character =
    input.characterDescription.trim() || "No locked character. Do not invent a celebrity.";
  const user = [
    `Genre: ${input.genre.trim() || "Unspecified"}`,
    `Style direction: ${input.styleDirection.trim() || "Cinematic live action."}`,
    `Character: ${character}`,
    "Timeline markers (label, start, end in seconds):",
    markerLines(input.markers),
    "Video concept or script:",
    lyrics.slice(0, 8000),
  ].join("\n");

  let text = "";
  try {
    text = await replicateChat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      {
        label: "Video shot script",
        model: SCRIPT_DIRECTOR_MODEL,
        maxTokens: SCRIPT_DIRECTOR_MAX_TOKENS,
        temperature: SCRIPT_DIRECTOR_TEMPERATURE,
        json: true,
        timeoutMs: 180_000,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The video shot script failed.";
    throw new Error(`The video shot script failed. ${message}`.slice(0, 500));
  }

  return parseDirectedShotList(text);
}
