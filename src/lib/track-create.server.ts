/**
 * Port-3000 POST /api/tracks/create.
 *
 * The HTTP handler saves an uploaded take, mints an ht_ session, and returns
 * pending JSON. The Replicate call is scheduled after that return and is never
 * awaited on the request.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LYRICS_MAX_CHARS, LYRICS_TOO_LONG_MESSAGE } from "@/lib/validation-error";
import { mapKeyToAutotuneScale, synchronizeVocal } from "./voice-synchronizer.server";

export const LYRIA_MODEL_ID = "google/lyria-3-pro";
/** Pro guide. No voice_file and no audio upload on this call. */
export const MINIMAX_MODEL_ID = "minimax/music-2.6";
export const MINIMAX_VERSION_ID =
  "dcd69b2c83c63ed612af65fc9842781fd7cf86db555e0b12ded7c6292bff8b7a";
/** Pinned nateraw/autotune prediction. Logged under this model id. */
export const AUTOTUNE_MODEL_ID = "nateraw/autotune";
export const AUTOTUNE_VERSION_ID =
  "53d58aea27ccd949e5f9d77e4b2a74ffe90e1fa534295b257cea50f011e233dd";
/**
 * Timbre model. This repo has no pinned hash for it. The version id is
 * latest_version.id from GET /models/cjwbw/rvc (metadata, not a prediction).
 */
export const RVC_MODEL_PATH = "cjwbw/rvc";
const WAV_ENROLLMENT_ERROR = "Voice conversion model cannot accept a wav enrollment";

const MIN_PROMPT = 50;
const MAX_PROMPT = 5000;
const PROMPT_TOO_SHORT = "Prompt must be at least 50 characters.";
const SESSION_RE = /^ht_[0-9a-f]{12}$/;
const TERMINAL = new Set(["succeeded", "failed", "canceled", "cancelled"]);

type TrackStatus = "pending" | "running" | "completed" | "failed";

type TrackJob = {
  sessionId: string;
  status: TrackStatus;
  vocalPresent: boolean;
  vocalPath: string | null;
  prompt: string;
  title: string;
  style: string;
  lyrics: string;
  mood: string;
  /** Raw form bpm. The sync call uses parseInt(bpm, 10) || 120. */
  bpmText: string;
  key: string;
  /** Requested length from the form. Not sent to music-2.6. */
  durationSeconds: number | null;
  error: string | null;
  masterUrl: string | null;
  audioFilename: string | null;
  step: string | null;
};

const jobs = new Map<string, TrackJob>();

export function trackScratchRoot(): string {
  const configured = (process.env.HYBRID_TRACK_SCRATCH || "").trim();
  return configured || path.join(os.tmpdir(), "hybrid-track-create");
}

export function resetTrackCreateForTests(): void {
  jobs.clear();
}

export function newTrackSessionId(): string {
  return `ht_${randomBytes(6).toString("hex")}`;
}

export function pendingCreateBody(sessionId: string, vocalPresent: boolean) {
  return {
    success: true as const,
    status: "pending" as const,
    session_id: sessionId,
    sessionId,
    track_id: sessionId,
    id: sessionId,
    token_cost: 1 as const,
    vocal_present: vocalPresent,
  };
}

function reject(status: number, detail: string): Response {
  return Response.json({ detail }, { status });
}

function textField(value: FormDataEntryValue | null): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function numberField(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const PROMPT_REQUIRED = "Prompt is required and cannot be empty.";

type ParsedCreate = {
  prompt: string;
  userPrompt: string;
  title: string;
  style: string;
  lyrics: string;
  mood: string;
  bpmText: string;
  key: string;
  durationSeconds: number | null;
  vocal: Buffer | null;
  vocalLane: boolean;
};

/** Title for Content-Disposition. Empty when the job has no user-facing title. */
function attachmentTrackName(title: string | null | undefined): string {
  return (title || "")
    .replace(/["'`\\/:*?<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.wav$/i, "");
}

function vocalPresentFlag(value: string): boolean | null {
  const flag = value.trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes" || flag === "on") return true;
  if (flag === "false" || flag === "0" || flag === "no" || flag === "off") return false;
  return null;
}

async function vocalBuffer(value: FormDataEntryValue | null): Promise<Buffer | null> {
  if (!(value instanceof Blob) || value.size <= 0) return null;
  const bytes = Buffer.from(await value.arrayBuffer());
  return bytes.byteLength > 0 ? bytes : null;
}

async function parseCreateRequest(request: Request): Promise<ParsedCreate | Response> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  let userPrompt = "";
  let style = "";
  let lyrics = "";
  let mood = "";
  let title = "";
  let bpmRaw: number | null = null;
  let musicalKey = "";
  let durationRaw: number | null = null;
  let vocalFlag: boolean | null = null;
  let vocal: Buffer | null = null;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return reject(400, PROMPT_REQUIRED);
    }
    userPrompt = textField(form.get("prompt"));
    style = textField(form.get("style"));
    lyrics = textField(form.get("lyrics"));
    mood = textField(form.get("mood"));
    title = textField(form.get("title"));
    musicalKey = textField(form.get("key"));
    bpmRaw = numberField(textField(form.get("bpm"))) ?? numberField(textField(form.get("tempo")));
    durationRaw =
      numberField(textField(form.get("duration"))) ?? numberField(textField(form.get("length")));
    vocalFlag = vocalPresentFlag(textField(form.get("vocal_present")));
    vocal =
      (await vocalBuffer(form.get("vocal_dna_file"))) ??
      (await vocalBuffer(form.get("vocal_file"))) ??
      (await vocalBuffer(form.get("voice_sample")));
  } else {
    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return reject(400, PROMPT_REQUIRED);
    }
    const read = (key: string) => (typeof payload[key] === "string" ? payload[key].trim() : "");
    userPrompt = read("prompt");
    style = read("style");
    lyrics = read("lyrics");
    mood = read("mood");
    title = read("title");
    musicalKey = read("key");
    const bpmValue = payload.bpm ?? payload.tempo;
    bpmRaw = typeof bpmValue === "number" || typeof bpmValue === "string" ? numberField(String(bpmValue)) : null;
    const durationValue = payload.duration ?? payload.length ?? payload.duration_sec;
    durationRaw =
      typeof durationValue === "number" || typeof durationValue === "string"
        ? numberField(String(durationValue))
        : null;
    const present = payload.vocal_present;
    vocalFlag =
      typeof present === "boolean"
        ? present
        : typeof present === "string" || typeof present === "number"
          ? vocalPresentFlag(String(present))
          : null;
  }

  if (vocalFlag === false) vocal = null;
  const vocalLane = vocalFlag === true || vocal != null;
  if (lyrics.length > LYRICS_MAX_CHARS) return reject(400, LYRICS_TOO_LONG_MESSAGE);
  const prompt = userPrompt;
  if (!prompt) return reject(400, PROMPT_REQUIRED);
  if (prompt.length > MAX_PROMPT) return reject(400, `prompt exceeds ${MAX_PROMPT} characters`);
  if (!vocalLane && prompt.length < MIN_PROMPT && !prompt.includes(",")) {
    return reject(400, PROMPT_TOO_SHORT);
  }
  const durationSeconds =
    durationRaw != null && durationRaw > 0 ? Math.min(420, Math.round(durationRaw)) : null;
  return {
    prompt,
    userPrompt,
    title,
    style,
    lyrics,
    mood,
    bpmText: bpmRaw == null ? "" : String(bpmRaw),
    key: musicalKey,
    durationSeconds,
    vocal,
    vocalLane,
  };
}

async function saveVocalDna(sessionId: string, bytes: Buffer): Promise<string> {
  const dir = path.join(trackScratchRoot(), sessionId);
  const dest = path.join(dir, "vocal_dna.wav");
  await mkdir(dir, { recursive: true });
  await writeFile(dest, bytes);
  await writeFile(path.join(dir, "ref_vocal_raw.wav"), bytes);
  return dest;
}

/**
 * Accept a create and return pending JSON before any model HTTP.
 * The model runs in a later turn via setImmediate.
 */
export async function handleTrackCreate(request: Request): Promise<Response> {
  const parsed = await parseCreateRequest(request);
  if (parsed instanceof Response) return parsed;

  let sessionId = newTrackSessionId();
  while (jobs.has(sessionId) || !SESSION_RE.test(sessionId)) sessionId = newTrackSessionId();

  let vocalPath: string | null = null;
  if (parsed.vocal) {
    try {
      vocalPath = await saveVocalDna(sessionId, parsed.vocal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "could not save vocal_dna.wav";
      return reject(500, `could not save vocal_dna.wav: ${detail}`);
    }
  }

  const vocalPresent = parsed.vocalLane;
  const job: TrackJob = {
    sessionId,
    status: "pending",
    vocalPresent,
    vocalPath,
    prompt: parsed.prompt,
    title: parsed.title,
    style: parsed.style,
    lyrics: parsed.lyrics,
    mood: parsed.mood,
    bpmText: parsed.bpmText,
    key: parsed.key,
    durationSeconds: parsed.durationSeconds,
    error: null,
    masterUrl: null,
    audioFilename: null,
    step: "pending",
  };
  jobs.set(sessionId, job);
  // After this function returns. Not awaited, so Cloudflare is not held open.
  setImmediate(() => {
    void runTrackJob(sessionId);
  });
  return Response.json(pendingCreateBody(sessionId, vocalPresent), { status: 200 });
}

export function trackStatusResponse(sessionId: string): Response {
  const id = (sessionId || "").trim();
  const job = jobs.get(id);
  if (!job) return Response.json({ detail: "unknown session" }, { status: 404 });
  return Response.json({
    session_id: job.sessionId,
    status: job.status,
    error: job.error,
    vocal_present: job.vocalPresent,
    token_cost: 1,
    master_url: job.masterUrl,
    audio_filename: job.audioFilename,
    step: job.step,
    note: job.step,
  });
}

export async function localMasterResponse(filename: string): Promise<Response | null> {
  const name = path.basename(filename);
  const match = /^ht_[0-9a-f]{12}_master\.wav$/i.exec(name);
  if (!match) return null;
  const sessionId = name.slice(0, name.length - "_master.wav".length);
  const filePath = path.resolve(trackScratchRoot(), sessionId, name);
  const root = path.resolve(trackScratchRoot());
  if (!filePath.startsWith(root + path.sep)) return null;
  try {
    const bytes = await readFile(filePath);
    const trackName = attachmentTrackName(jobs.get(sessionId)?.title);
    const headers = new Headers();
    headers.set("Content-Disposition", `attachment; filename="${trackName || "master"}.wav"`);
    headers.set("Content-Type", "audio/wav");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers,
    });
  } catch {
    return null;
  }
}

function replicateToken(): string {
  const key = (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || "").trim();
  if (!key) throw new Error("REPLICATE_API_TOKEN is not configured");
  return key;
}

function replicateBase(): string {
  return (process.env.REPLICATE_API_BASE_URL || "https://api.replicate.com/v1").replace(/\/+$/, "");
}

function lyriaPrompt(job: TrackJob): string {
  const style = job.style.trim();
  let prompt = job.prompt.trim();
  const lyrics = job.lyrics.trim();
  if (lyrics && prompt === lyrics) prompt = "";
  const head =
    style && prompt && prompt !== style ? `${style}\n${prompt}` : style || prompt;
  if (head && lyrics) return `${head}\n\n${lyrics}`;
  return head || lyrics;
}

type Prediction = {
  id?: string;
  status?: string;
  error?: unknown;
  output?: unknown;
  urls?: { get?: string };
};

function guidePrompt(prompt: string, bpmText: string): string {
  const bpm = parseInt(bpmText, 10) || 120;
  return `${prompt.trim()}, ${bpm} BPM, studio production`;
}

function guideRequest(job: TrackJob): { url: string; body: Record<string, unknown> } {
  return {
    url: `${replicateBase()}/predictions`,
    body: {
      version: MINIMAX_VERSION_ID,
      input: {
        prompt: guidePrompt(job.prompt, job.bpmText),
        lyrics: job.lyrics.trim(),
        lyrics_optimizer: false,
        is_instrumental: false,
        audio_format: "wav",
        sample_rate: 44100,
        bitrate: 256000,
      },
    },
  };
}

async function replicateJson(url: string, token: string, payload: Record<string, unknown> | null): Promise<Prediction> {
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as Prediction;
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

function outputUrl(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && typeof output[0] === "string") return output[0];
  if (output && typeof output === "object") {
    const record = output as { audio?: unknown; url?: unknown };
    if (typeof record.audio === "string") return record.audio;
    if (typeof record.url === "string") return record.url;
  }
  return "";
}

async function pollPrediction(start: Prediction, token: string): Promise<Prediction> {
  let current = start;
  const deadline = Date.now() + 8 * 60_000;
  while (!TERMINAL.has(String(current.status || ""))) {
    if (Date.now() > deadline) throw new Error("prediction timed out");
    const pollUrl = (current.urls?.get || "").trim();
    if (!pollUrl) throw new Error("prediction has no urls.get");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    current = await replicateJson(pollUrl, token, null);
  }
  const status = String(current.status || "");
  if (status !== "succeeded") {
    throw new Error(String(current.error || status || "prediction failed"));
  }
  return current;
}

async function requireMasterFile(masterPath: string): Promise<void> {
  let info;
  try {
    info = await stat(masterPath);
  } catch {
    throw new Error("master wav is missing");
  }
  if (!info.isFile() || info.size <= 0) throw new Error("master wav is missing");
}

async function requireVocalDna(vocalPath: string): Promise<void> {
  try {
    const info = await stat(vocalPath);
    if (!info.isFile() || info.size <= 0) throw new Error("Voice API failed: vocal_dna.wav is missing");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Voice API failed:")) throw error;
    throw new Error("Voice API failed: vocal_dna.wav is missing");
  }
}

function voiceFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Generation failed.";
  if (message === WAV_ENROLLMENT_ERROR || message.startsWith("Voice API failed:")) return message;
  return `Voice API failed: ${message}`;
}

async function downloadWav(audioUrl: string, dest: string, emptyError: string): Promise<void> {
  const audio = await fetch(audioUrl);
  if (!audio.ok) throw new Error(`audio download HTTP ${audio.status}`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (bytes.byteLength <= 0) throw new Error(emptyError);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
}

async function writeMaster(job: TrackJob, audioUrl: string): Promise<void> {
  const masterName = `${job.sessionId}_master.wav`;
  const masterPath = path.join(trackScratchRoot(), job.sessionId, masterName);
  await downloadWav(audioUrl, masterPath, "master wav is missing");
  await requireMasterFile(masterPath);
  job.status = "completed";
  job.step = "completed";
  job.error = null;
  job.audioFilename = masterName;
  job.masterUrl = `/api/stream/${masterName}`;
}

async function runLyria(job: TrackJob, token: string): Promise<void> {
  const created = await replicateJson(
    `${replicateBase()}/models/${LYRIA_MODEL_ID}/predictions`,
    token,
    { input: { prompt: lyriaPrompt(job) } },
  );
  const done = await pollPrediction(created, token);
  const audioUrl = outputUrl(done.output);
  if (!audioUrl) throw new Error("prediction returned no audio");
  await writeMaster(job, audioUrl);
}

type SchemaProperty = { type?: string; description?: string };

const REFERENCE_AUDIO_KEYS = [
  "reference_audio",
  "ref_audio",
  "reference_wav",
  "voice_reference",
  "speaker_audio",
  "enrollment_audio",
  "target_voice_audio",
  "voice_sample",
  "reference",
] as const;

function propertyDescription(spec: SchemaProperty | undefined): string {
  return (spec?.description || "").trim();
}

function describesModelZip(description: string): boolean {
  return /zip|\.pth|\.index|trained model|rvc model|model weights|download a custom rvc/i.test(description);
}

/** The model-download field accepts a wav only when its description says so and does not require a zip. */
function modelUrlAcceptsEnrollmentWav(spec: SchemaProperty | undefined): boolean {
  if (!spec) return false;
  const description = propertyDescription(spec);
  if (describesModelZip(description)) return false;
  return /\bwav\b|audio file|voice recording|reference audio|voice sample|enrollment/i.test(description);
}

function referenceAudioField(properties: Record<string, SchemaProperty>): string | null {
  for (const key of REFERENCE_AUDIO_KEYS) {
    const spec = properties[key];
    if (spec && !describesModelZip(propertyDescription(spec))) return key;
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (
      key === "input_audio" ||
      key === "song_input" ||
      key === "custom_rvc_model_download_url" ||
      key === "pitch_change" ||
      key === "index_rate" ||
      key === "protect" ||
      key === "rvc_model" ||
      key === "f0_method"
    ) {
      continue;
    }
    const description = propertyDescription(spec);
    if (
      /reference (audio|recording|voice)|voice (sample|enrollment|identity)|speaker (audio|reference)|enrollment audio/i.test(
        description,
      ) &&
      !describesModelZip(description)
    ) {
      return key;
    }
  }
  return null;
}

function schemaProperties(schema: unknown): Record<string, SchemaProperty> {
  if (!schema || typeof schema !== "object") return {};
  const properties = (
    schema as { components?: { schemas?: { Input?: { properties?: unknown } } } }
  ).components?.schemas?.Input?.properties;
  if (!properties || typeof properties !== "object") return {};
  const parsed: Record<string, SchemaProperty> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== "object") {
      parsed[key] = {};
      continue;
    }
    const spec = value as { type?: unknown; description?: unknown };
    parsed[key] = {
      type: typeof spec.type === "string" ? spec.type : undefined,
      description: typeof spec.description === "string" ? spec.description : undefined,
    };
  }
  return parsed;
}

/**
 * Build the timbre input from the live schema.
 * A zipped .pth download field never receives the enrollment wav.
 * Returns null when no field can carry a 30s wav as the voice identity.
 */
function rvcInput(
  properties: Record<string, SchemaProperty>,
  vocalDnaUrl: string,
  guideAudioUrl: string,
): Record<string, unknown> | null {
  const guideKey = properties.input_audio ? "input_audio" : properties.song_input ? "song_input" : "";
  if (!guideKey) return null;
  const input: Record<string, unknown> = { [guideKey]: guideAudioUrl };
  if (modelUrlAcceptsEnrollmentWav(properties.custom_rvc_model_download_url)) {
    input.custom_rvc_model_download_url = vocalDnaUrl;
  } else {
    const referenceKey = referenceAudioField(properties);
    if (!referenceKey) return null;
    input[referenceKey] = vocalDnaUrl;
  }
  if (properties.pitch_change) input.pitch_change = 0;
  if (properties.index_rate) input.index_rate = 0.75;
  if (properties.protect) input.protect = 0.33;
  return input;
}

async function lookupCjwbwRvc(token: string): Promise<{ versionId: string; properties: Record<string, SchemaProperty> }> {
  const response = await fetch(`${replicateBase()}/models/${RVC_MODEL_PATH}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const data = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
    latest_version?: { id?: unknown; openapi_schema?: unknown };
  };
  if (!response.ok) {
    const detail =
      typeof data.detail === "string" && data.detail.trim() ? data.detail.trim() : `HTTP ${response.status}`;
    throw new Error(`Voice conversion model lookup failed: HTTP ${response.status} ${detail}`);
  }
  const versionId = typeof data.latest_version?.id === "string" ? data.latest_version.id.trim() : "";
  if (!versionId) throw new Error("Voice conversion model lookup failed: missing version id");
  return { versionId, properties: schemaProperties(data.latest_version?.openapi_schema) };
}

async function uploadReplicateWav(filePath: string, token: string): Promise<string> {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("content", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), path.basename(filePath));
  const response = await fetch(`${replicateBase()}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = (await response.json().catch(() => ({}))) as {
    urls?: { get?: unknown };
    detail?: unknown;
    error?: unknown;
  };
  if (!response.ok) {
    const detail =
      typeof data.detail === "string"
        ? data.detail
        : typeof data.error === "string"
          ? data.error
          : `HTTP ${response.status}`;
    throw new Error(`Replicate file upload failed: ${detail}`);
  }
  const url = typeof data.urls?.get === "string" ? data.urls.get.trim() : "";
  if (!url) throw new Error("Replicate file upload did not return a URL");
  return url;
}

async function runTimbreMorph(token: string, syncedPath: string, guidePath: string, job: TrackJob): Promise<void> {
  const model = await lookupCjwbwRvc(token);
  if (!rvcInput(model.properties, "https://files.example/vocal.wav", "https://files.example/guide.wav")) {
    throw new Error(WAV_ENROLLMENT_ERROR);
  }
  const vocalDnaUrl = await uploadReplicateWav(syncedPath, token);
  const guideAudioUrl = await uploadReplicateWav(guidePath, token);
  const input = rvcInput(model.properties, vocalDnaUrl, guideAudioUrl);
  if (!input) throw new Error(WAV_ENROLLMENT_ERROR);
  const created = await replicateJson(`${replicateBase()}/predictions`, token, {
    version: model.versionId,
    input,
  });
  const done = await pollPrediction(created, token);
  const audioUrl = outputUrl(done.output);
  if (!audioUrl) throw new Error("prediction returned no audio");
  await writeMaster(job, audioUrl);
}

/**
 * Pitch-correct the synced take. Request, poll, and download failures keep
 * ref_vocal_synced.wav as the timbre reference and do not fail the job.
 */
async function tuneSyncedVocal(job: TrackJob, syncedPath: string, token: string): Promise<string> {
  const tunedPath = path.join(trackScratchRoot(), job.sessionId, "vocal_dna_tuned.wav");
  try {
    const syncedVocalUrl = await uploadReplicateWav(syncedPath, token);
    const created = await replicateJson(`${replicateBase()}/predictions`, token, {
      version: AUTOTUNE_VERSION_ID,
      input: {
        audio_file: syncedVocalUrl,
        scale: mapKeyToAutotuneScale(job.key || "E Major"),
        output_format: "wav",
      },
    });
    const done = await pollPrediction(created, token);
    const audioUrl = outputUrl(done.output);
    if (!audioUrl) throw new Error("auto-tune returned no audio");
    await downloadWav(audioUrl, tunedPath, "tuned vocal wav is missing");
    return tunedPath;
  } catch (error) {
    console.error(
      `[${AUTOTUNE_MODEL_ID}] auto-tune failed, continuing with ref_vocal_synced.wav:`,
      error,
    );
    return syncedPath;
  }
}

async function runVocalContinuation(job: TrackJob): Promise<void> {
  const scratchDir = path.join(trackScratchRoot(), job.sessionId);
  const dnaPath = path.join(scratchDir, "vocal_dna.wav");
  const syncedPath = path.join(scratchDir, "ref_vocal_synced.wav");
  const guidePath = path.join(scratchDir, "guide_raw.wav");
  await requireVocalDna(dnaPath);
  job.step = "guide";
  await synchronizeVocal({
    inputPath: dnaPath,
    outputPath: syncedPath,
    bpm: parseInt(job.bpmText, 10) || 120,
    key: job.key || "E Major",
  });
  const token = replicateToken();
  const vocalReferencePath = await tuneSyncedVocal(job, syncedPath, token);
  const request = guideRequest(job);
  const created = await replicateJson(request.url, token, request.body);
  const done = await pollPrediction(created, token);
  const remoteGuide = outputUrl(done.output);
  if (!remoteGuide) throw new Error("prediction returned no audio");
  await downloadWav(remoteGuide, guidePath, "guide wav is missing");
  job.step = "timbre";
  await runTimbreMorph(token, vocalReferencePath, guidePath, job);
}

async function runTrackJob(sessionId: string): Promise<void> {
  const job = jobs.get(sessionId);
  if (!job || job.status === "completed") return;
  job.status = "running";
  job.step = job.vocalPresent ? "guide" : LYRIA_MODEL_ID;
  try {
    if (job.vocalPresent) {
      await runVocalContinuation(job);
      return;
    }
    await runLyria(job, replicateToken());
  } catch (error) {
    job.status = "failed";
    job.step = "failed";
    job.error = job.vocalPresent
      ? voiceFailure(error)
      : error instanceof Error
        ? error.message
        : "Generation failed.";
    job.masterUrl = null;
  }
}
