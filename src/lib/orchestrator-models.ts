/**
 * Central orchestration model lock for the Visual Engine.
 *
 * The orchestrator is the "Nano Banana Pro" tier: it reads the audio profile
 * (BPM, mood, structure) produced by the Gemini stem analysis, parses the full
 * song structure and lyric timestamps, and distributes the shot list. Its
 * output feeds Seedream 5.0 / Flux 3 (foundation stills) and Seedance 2.0
 * (motion) with no fallback drift — the visual engines never re-plan a shot.
 *
 * Keep every orchestration call pointed at these constants so the whole
 * pipeline moves as one when the tier changes.
 */

/**
 * Reasoning / parsing tier of Nano Banana Pro. Handles song-structure parsing,
 * lyric timestamp mapping and shot-list distribution.
 */
export const ORCHESTRATOR_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Vision tier of the same orchestrator — reference-photo reading and character
 * autofill, where an image must be interpreted rather than generated.
 */
export const ORCHESTRATOR_VISION_MODEL = "google/gemini-3.5-flash-lite";

/**
 * Image tier of Nano Banana Pro. Used for concept stills and any orchestrator
 * step that must render a frame rather than describe one.
 */
export const ORCHESTRATOR_IMAGE_MODEL = "google/gemini-3-pro-image";

/** Human-facing label; never expose vendor model ids in the UI. */
export const ORCHESTRATOR_LABEL = "Hybrid Orchestrator Pro";

/**
 * Fast worker tier ("Nano Banana 2"). Handles real-time script adjustments and
 * localized prompt tuning where latency matters more than global planning.
 * It never plans song structure or distributes a shot list — that stays with
 * the master orchestrator above, so the two tiers can't drift apart.
 */
export const FAST_WORKER_MODEL = "google/gemini-3.5-flash-lite";

/** Human-facing label for the fast worker tier. */
export const FAST_WORKER_LABEL = "Hybrid Orchestrator Rapid";
