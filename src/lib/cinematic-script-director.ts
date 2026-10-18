import { clampCinematicSeconds } from "@/lib/cinematic-seconds";

/** One shot from the video script director. The model must return a list of these. */
export type DirectedShot = {
  timestamp_start: number;
  timestamp_end: number;
  scene_type: string;
  prompt_flux: string;
  motion_prompt: string;
};

export type StudioScene = {
  index: number;
  title: string;
  /** Motion prompt sent to Hailuo or Seedance. */
  shot: string;
  /** Still prompt sent to Flux. */
  stillPrompt: string;
  seconds: number;
  vocalSync: boolean;
};

const SINGING_SCENE = /\b(sing|vocal|lip|performance|close-?up|portrait|artist)\b/i;

function stripFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

/**
 * Parses the director reply. A JSON object is a failure even if it contains a list.
 * Generate must stop when this throws.
 */
export function parseDirectedShotList(raw: string): DirectedShot[] {
  const text = stripFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The shot list was not JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("The shot list must be a JSON list.");
  }
  if (parsed.length === 0) throw new Error("The shot list was empty.");

  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Shot ${index + 1} is not an object.`);
    }
    const row = item as Record<string, unknown>;
    const timestampStart = Number(row.timestamp_start);
    const timestampEnd = Number(row.timestamp_end);
    const sceneType = typeof row.scene_type === "string" ? row.scene_type.trim() : "";
    const promptFlux = typeof row.prompt_flux === "string" ? row.prompt_flux.trim() : "";
    const motionPrompt = typeof row.motion_prompt === "string" ? row.motion_prompt.trim() : "";
    if (
      !Number.isFinite(timestampStart) ||
      !Number.isFinite(timestampEnd) ||
      timestampEnd <= timestampStart
    ) {
      throw new Error(`Shot ${index + 1} has an invalid time range.`);
    }
    if (!sceneType || promptFlux.length < 8 || motionPrompt.length < 8) {
      throw new Error(`Shot ${index + 1} is missing scene_type, prompt_flux, or motion_prompt.`);
    }
    return {
      timestamp_start: timestampStart,
      timestamp_end: timestampEnd,
      scene_type: sceneType.slice(0, 80),
      prompt_flux: promptFlux.slice(0, 1500),
      motion_prompt: motionPrompt.slice(0, 1500),
    };
  });
}

/**
 * Uses a pasted script as the scenes. Claude is not called.
 * Each paragraph or sentence becomes one shot across the track.
 */
export function scenesFromVision(
  vision: string,
  durationSeconds: number,
  lipsync: boolean,
): StudioScene[] {
  const chunks = vision
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8)
    .slice(0, 8);
  const parts = chunks.length > 0 ? chunks : [vision.trim() || "A continuous music-video image."];
  const slice = Math.max(4, durationSeconds) / parts.length;
  return parts.map((text, index) => ({
    index,
    title: `Scene ${index + 1}`,
    shot: text,
    stillPrompt: text,
    seconds: clampCinematicSeconds(slice),
    vocalSync: lipsync && SINGING_SCENE.test(text),
  }));
}

/** Turns a valid shot list into render blocks. Lip-sync is marked only when vocals were isolated. */
export function shotsToScenes(shots: DirectedShot[], lipsync: boolean): StudioScene[] {
  return shots.map((shot, index) => ({
    index,
    title: shot.scene_type.slice(0, 120),
    shot: shot.motion_prompt,
    stillPrompt: shot.prompt_flux,
    seconds: clampCinematicSeconds(shot.timestamp_end - shot.timestamp_start),
    vocalSync: lipsync && SINGING_SCENE.test(shot.scene_type),
  }));
}
