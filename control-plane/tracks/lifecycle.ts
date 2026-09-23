// Pure job-lifecycle logic (no Encore imports, unit-testable with Vitest).
import { randomBytes, timingSafeEqual } from "node:crypto";

export type TrackStatus = "queued" | "processing" | "completed" | "failed";
export const ACTIVE_STATUSES: readonly TrackStatus[] = ["queued", "processing"];

/** Same format the Python worker validates for client-supplied session ids. */
export const SESSION_ID_RE = /^ht_[0-9a-f]{12}$/;

export function newSessionId(): string {
  return `ht_${randomBytes(6).toString("hex")}`;
}

export const LIMITS = {
  titleMax: 255,
  genreMax: 64,
  keyMax: 32,
  promptMax: 2000,
  bpmMin: 60,
  bpmMax: 200,
  barsMin: 4,
  barsMax: 128,
} as const;

// Root + optional accidental + optional mode: E, F#, Bb minor, D_min, Em.
const KEY_RE = /^[A-Ga-g](#|b)?([\s_]?(major|minor|maj|min|m|dorian|mixolydian|lydian|phrygian|aeolian|ionian))?$/i;

export interface CreateTrackInput {
  title: string;
  genre: string;
  keySignature: string;
  bpm: number;
  bars: number;
  prompt?: string;
}

/** Human-readable problem, or null when valid. */
export function validateCreateTrack(req: CreateTrackInput): string | null {
  const title = (req.title ?? "").trim();
  const genre = (req.genre ?? "").trim();
  const key = (req.keySignature ?? "").trim();
  if (!title) return "title is required";
  if (title.length > LIMITS.titleMax) return `title exceeds ${LIMITS.titleMax} characters`;
  if (!genre) return "genre is required";
  if (genre.length > LIMITS.genreMax) return `genre exceeds ${LIMITS.genreMax} characters`;
  if (!key || key.length > LIMITS.keyMax || !KEY_RE.test(key)) {
    return "keySignature must look like 'E minor', 'F#', or 'Bb_major'";
  }
  if (!Number.isInteger(req.bpm) || req.bpm < LIMITS.bpmMin || req.bpm > LIMITS.bpmMax) {
    return `bpm must be an integer in [${LIMITS.bpmMin}, ${LIMITS.bpmMax}]`;
  }
  if (!Number.isInteger(req.bars) || req.bars < LIMITS.barsMin || req.bars > LIMITS.barsMax) {
    return `bars must be an integer in [${LIMITS.barsMin}, ${LIMITS.barsMax}]`;
  }
  if (req.prompt !== undefined && req.prompt.length > LIMITS.promptMax) {
    return `prompt exceeds ${LIMITS.promptMax} characters`;
  }
  return null;
}

/** Worker prompt: explicit prompt, else a descriptive one from the metadata. */
export function workerPrompt(req: CreateTrackInput): string {
  const explicit = (req.prompt ?? "").trim();
  if (explicit) return explicit;
  return `${req.title.trim()}, ${req.genre.trim()}, ${req.keySignature.trim()}, ${req.bpm} BPM`;
}

export const STEM_NAME_RE = /^[a-z0-9_]{1,40}$/;
export const MAX_STEMS = 16;

export interface DeliveryObject {
  key: string;
  contentType: string;
}

/**
 * Bucket layout for one session. Upload-URL names: master, mp3, manifest,
 * zip, stem_<name>. Throws on invalid stem names (they become object keys).
 */
export function deliveryObjects(sessionId: string, stems: readonly string[]): Record<string, DeliveryObject> {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id '${sessionId}'`);
  if (stems.length > MAX_STEMS) throw new Error(`at most ${MAX_STEMS} stems`);
  const prefix = `deliveries/${sessionId}`;
  const out: Record<string, DeliveryObject> = {
    master: { key: `${prefix}/master.wav`, contentType: "audio/wav" },
    mp3: { key: `${prefix}/master.mp3`, contentType: "audio/mpeg" },
    manifest: { key: `${prefix}/manifest.json`, contentType: "application/json" },
    zip: { key: `${prefix}/${sessionId}_stems_bundle.zip`, contentType: "application/zip" },
  };
  for (const stem of stems) {
    if (!STEM_NAME_RE.test(stem)) throw new Error(`invalid stem name '${stem}'`);
    out[`stem_${stem}`] = { key: `${prefix}/stems/${stem}.wav`, contentType: "audio/wav" };
  }
  return out;
}

/** Objects that must exist before a job may be marked completed. */
export function requiredObjectNames(objects: Record<string, DeliveryObject>): string[] {
  return Object.keys(objects).filter((name) => name !== "mp3");
}

/** Constant-time comparison for shared-secret headers. */
export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Subset of the worker's _public_job() used when reconciling stuck jobs. */
export interface WorkerJob {
  session_id: string;
  status: string;
  error?: string | null;
  delivery_status?: string | null;
  delivery_error?: string | null;
  integrated_lufs?: number | null;
  true_peak_dbtp?: number | null;
  provenance_score?: number | null;
  provenance_status?: string | null;
}

export type WorkerOutcome =
  | { kind: "pending" }
  | { kind: "completed" }
  | { kind: "failed"; error: string };

export function classifyWorkerJob(job: WorkerJob): WorkerOutcome {
  switch (job.status) {
    case "queued":
    case "running":
      return { kind: "pending" };
    case "completed":
      return job.delivery_status === "completed"
        ? { kind: "completed" }
        : { kind: "failed", error: `worker completed without delivery (delivery_status=${job.delivery_status ?? "none"})` };
    case "failed":
      return { kind: "failed", error: job.delivery_error || job.error || "worker reported failure without detail" };
    default:
      return { kind: "failed", error: `unknown worker status '${job.status}'` };
  }
}
