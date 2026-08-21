/**
 * Replicate dispatch payload schema (pure, shared).
 *
 * Runs immediately before a paid motion dispatch so a malformed body — an
 * unknown key, a missing prompt, a duration the model rejects, an audio value
 * that isn't a fetchable source — is caught locally instead of burning a
 * provider call on a guaranteed 422.
 */

/** Keys every motion model in the stack accepts. */
const ALLOWED_KEYS = new Set([
  "prompt",
  "negative_prompt",
  "duration",
  "resolution",
  "aspect_ratio",
  "image",
  "start_image",
  "reference_images",
  "audio",
  "audio_url",
  "seed",
  "fps",
]);

const REQUIRED_KEYS = ["prompt", "duration", "resolution", "aspect_ratio"] as const;

/** Values a model can actually fetch or decode. */
const SOURCE_PATTERN = /^(https?:|data:|blob:|\/)/i;

export type DispatchIssue = { key: string; message: string };

export type DispatchValidation =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; issues: DispatchIssue[] };

/** Validates the exact object that will be POSTed as `{ input: payload }`. */
export function validateDispatchPayload(payload: Record<string, unknown>): DispatchValidation {
  const issues: DispatchIssue[] = [];

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(key)) {
      issues.push({ key, message: `\`${key}\` is not part of the motion model schema.` });
    }
  }

  for (const key of REQUIRED_KEYS) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      issues.push({ key, message: `\`${key}\` is required by the motion model.` });
    }
  }

  const prompt = payload["prompt"];
  if (prompt !== undefined && (typeof prompt !== "string" || prompt.trim().length < 8)) {
    issues.push({ key: "prompt", message: "The shot prompt is empty or too short to render." });
  }

  const duration = payload["duration"];
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1 || duration > 12)) {
    issues.push({ key: "duration", message: "Block duration must be a number of seconds between 1 and 12." });
  }

  const aspect = payload["aspect_ratio"];
  if (aspect !== undefined && typeof aspect !== "string") {
    issues.push({ key: "aspect_ratio", message: "Aspect ratio must be a string such as `16:9`." });
  }

  const resolution = payload["resolution"];
  if (resolution !== undefined && typeof resolution !== "string") {
    issues.push({ key: "resolution", message: "Resolution must be a string such as `1080p`." });
  }

  for (const key of ["image", "start_image", "audio", "audio_url"] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !SOURCE_PATTERN.test(value.trim())) {
      issues.push({ key, message: `\`${key}\` must be a URL or data URI the engine can read.` });
    }
  }

  const references = payload["reference_images"];
  if (references !== undefined) {
    if (!Array.isArray(references) || references.length === 0 || references.length > 4) {
      issues.push({ key: "reference_images", message: "Reference images must be an array of 1–4 sources." });
    } else if (references.some((r) => typeof r !== "string" || !SOURCE_PATTERN.test(r.trim()))) {
      issues.push({ key: "reference_images", message: "Every reference image must be a URL or data URI." });
    }
  }

  const audio = payload["audio"];
  const audioUrl = payload["audio_url"];
  if ((audio === undefined) !== (audioUrl === undefined)) {
    issues.push({
      key: "audio",
      message: "The audio slice must be sent on both `audio` and `audio_url` so either schema variant resolves it.",
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, payload };
}

/** Single-line summary for logs and error surfaces. */
export function describeDispatchIssues(issues: DispatchIssue[]): string {
  return issues.map((i) => i.message).join(" ");
}
