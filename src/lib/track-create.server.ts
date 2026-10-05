/**
 * Port-3000 POST /api/tracks/create.
 *
 * The HTTP handler saves an uploaded take, mints an ht_ session, and returns
 * pending JSON. The Replicate call is scheduled after that return and is never
 * awaited on the request.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LYRICS_MAX_CHARS, LYRICS_TOO_LONG_MESSAGE } from "@/lib/validation-error";

export const LYRIA_MODEL_ID = "google/lyria-3-pro";
export const MINIMAX_MODEL_ID = "minimax/music-2.6";
export const MINIMAX_VERSION_ID =
  "dcd69b2c83c63ed612af65fc9842781fd7cf86db555e0b12ded7c6292bff8b7a";

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
  style: string;
  lyrics: string;
  mood: string;
  bpm: number;
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

type ParsedCreate = {
  prompt: string;
  userPrompt: string;
  style: string;
  lyrics: string;
  mood: string;
  bpm: number;
  vocal: Buffer | null;
};

async function vocalBuffer(value: FormDataEntryValue | null): Promise<Buffer | null> {
  if (!(value instanceof Blob) || value.size < 64) return null;
  const bytes = Buffer.from(await value.arrayBuffer());
  return bytes.byteLength >= 64 ? bytes : null;
}

async function parseCreateRequest(request: Request): Promise<ParsedCreate | Response> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  let userPrompt = "";
  let style = "";
  let lyrics = "";
  let mood = "";
  let title = "";
  let bpmRaw: number | null = null;
  let vocal: Buffer | null = null;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return reject(400, "prompt is required");
    }
    userPrompt = textField(form.get("prompt"));
    style = textField(form.get("style"));
    lyrics = textField(form.get("lyrics"));
    mood = textField(form.get("mood"));
    title = textField(form.get("title"));
    bpmRaw = numberField(textField(form.get("bpm"))) ?? numberField(textField(form.get("tempo")));
    vocal = (await vocalBuffer(form.get("vocal_file"))) ?? (await vocalBuffer(form.get("voice_sample")));
  } else {
    let payload: Record<string, unknown>;
    try {
      payload = (await request.json()) as Record<string, unknown>;
    } catch {
      return reject(400, "prompt is required");
    }
    const read = (key: string) => (typeof payload[key] === "string" ? payload[key].trim() : "");
    userPrompt = read("prompt");
    style = read("style");
    lyrics = read("lyrics");
    mood = read("mood");
    title = read("title");
    const bpmValue = payload.bpm ?? payload.tempo;
    bpmRaw = typeof bpmValue === "number" || typeof bpmValue === "string" ? numberField(String(bpmValue)) : null;
  }

  if (lyrics.length > LYRICS_MAX_CHARS) return reject(400, LYRICS_TOO_LONG_MESSAGE);
  if (userPrompt && userPrompt.length < MIN_PROMPT && !style) return reject(400, PROMPT_TOO_SHORT);
  const prompt = (userPrompt || title || style).trim();
  if (!prompt) return reject(400, "prompt is required");
  if (prompt.length > MAX_PROMPT) return reject(400, `prompt exceeds ${MAX_PROMPT} characters`);
  const bpm = bpmRaw != null && bpmRaw >= 60 && bpmRaw <= 200 ? bpmRaw : 86;
  return { prompt, userPrompt, style, lyrics, mood, bpm, vocal };
}

async function saveRefVocal(sessionId: string, bytes: Buffer): Promise<string> {
  const dir = path.join(trackScratchRoot(), sessionId);
  const dest = path.join(dir, "ref_vocal.wav");
  await mkdir(dir, { recursive: true });
  await writeFile(dest, bytes);
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
      vocalPath = await saveRefVocal(sessionId, parsed.vocal);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "could not save ref_vocal.wav";
      return reject(500, `could not save ref_vocal.wav: ${detail}`);
    }
  }

  const vocalPresent = Boolean(vocalPath);
  const job: TrackJob = {
    sessionId,
    status: "pending",
    vocalPresent,
    vocalPath,
    prompt: parsed.prompt,
    style: parsed.style,
    lyrics: parsed.lyrics,
    mood: parsed.mood,
    bpm: parsed.bpm,
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
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-disposition": `inline; filename="${name}"`,
      },
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

function minimaxPrompt(job: TrackJob): string {
  const user = job.prompt.trim();
  const mood = job.mood.trim();
  const base = mood && !user.toLowerCase().includes(mood.toLowerCase()) ? `${user}, ${mood}` : user;
  const tempo = Number.isInteger(job.bpm) ? String(job.bpm) : String(job.bpm);
  return `${base}, ${tempo} BPM, instrumental, studio production`;
}

type Prediction = {
  id?: string;
  status?: string;
  error?: unknown;
  output?: unknown;
  urls?: { get?: string };
};

/** Model request scheduled after the HTTP response. No vocal bytes are attached. */
export function modelRequestForJob(job: Pick<TrackJob, "vocalPresent" | "prompt" | "style" | "lyrics" | "mood" | "bpm">): {
  url: string;
  body: Record<string, unknown>;
} {
  const base = replicateBase();
  if (job.vocalPresent) {
    return {
      url: `${base}/predictions`,
      body: {
        version: MINIMAX_VERSION_ID,
        input: {
          prompt: minimaxPrompt(job as TrackJob),
          is_instrumental: true,
          lyrics_optimizer: false,
          audio_format: "wav",
          sample_rate: 44100,
          bitrate: 256000,
        },
      },
    };
  }
  return {
    url: `${base}/models/${LYRIA_MODEL_ID}/predictions`,
    body: { input: { prompt: lyriaPrompt(job as TrackJob) } },
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

function mixRefVocal(bedPath: string, vocalPath: string, masterPath: string): Promise<void> {
  const args = [
    "-y",
    "-i",
    bedPath,
    "-i",
    vocalPath,
    "-filter_complex",
    "[1:a]loudnorm=I=-16:TP=-1.5:LRA=11[voc];[0:a]volume=0.85[bed];[bed][voc]amix=inputs=2:duration=first:dropout_transition=2[out]",
    "-map",
    "[out]",
    "-ar",
    "44100",
    "-ac",
    "2",
    masterPath,
  ];
  return new Promise((resolve, rejectMix) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectMix(error);
    };
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") fail(new Error("ffmpeg is not installed"));
      else fail(error instanceof Error ? error : new Error("ffmpeg is not installed"));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve();
        return;
      }
      const detail = stderr.trim();
      fail(new Error(detail || `ffmpeg exited ${code}`));
    });
  });
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

async function runTrackJob(sessionId: string): Promise<void> {
  const job = jobs.get(sessionId);
  if (!job || job.status === "completed") return;
  job.status = "running";
  job.step = job.vocalPresent ? MINIMAX_MODEL_ID : LYRIA_MODEL_ID;
  try {
    const token = replicateToken();
    const request = modelRequestForJob(job);
    const created = await replicateJson(request.url, token, request.body);
    const done = await pollPrediction(created, token);
    const audioUrl = outputUrl(done.output);
    if (!audioUrl) throw new Error("prediction returned no audio");
    const audio = await fetch(audioUrl);
    if (!audio.ok) throw new Error(`audio download HTTP ${audio.status}`);
    const bytes = Buffer.from(await audio.arrayBuffer());
    const dir = path.join(trackScratchRoot(), sessionId);
    await mkdir(dir, { recursive: true });
    const masterName = `${sessionId}_master.wav`;
    const masterPath = path.join(dir, masterName);
    if (job.vocalPresent && job.vocalPath) {
      const bedPath = path.join(dir, "bed_instrumental.wav");
      await writeFile(bedPath, bytes);
      await mixRefVocal(bedPath, job.vocalPath, masterPath);
    } else {
      await writeFile(masterPath, bytes);
    }
    await requireMasterFile(masterPath);
    job.status = "completed";
    job.step = "completed";
    job.error = null;
    job.audioFilename = masterName;
    job.masterUrl = `/api/stream/${masterName}`;
  } catch (error) {
    job.status = "failed";
    job.step = "failed";
    job.error = error instanceof Error ? error.message : "Generation failed.";
  }
}
