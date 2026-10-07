import { createClient } from "@supabase/supabase-js";
import { isMp3FrameOrId3, wavToMp3 } from "@/lib/audio/wavToMp3";
import {
  formatMurekaLyrics,
  formatMurekaPrompt,
  replaceBareConflictingPrompt,
} from "@/lib/mureka-format";
import {
  beginDelivery,
  completeTrackJob,
  failTrackJob,
  readTrackJob,
  rememberTrackJob,
  type TrackJob,
} from "@/lib/wavespeed-track-jobs.server";

const GENERATE_SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const GENERATE_BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";

/** Harmless on Bun. Next.js route segment config when this file is used as a route. */
export const maxDuration = 360;

const SUBMIT_RETRIES = 3;
const RESULT_RETRIES = 5;
const POLL_DEADLINE_MS = 60 * 60 * 1000;
const VAULT_BUCKET = "audio-vault";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lowercase "male" or "female". "Male (m)" counts as male. Anything else is omitted. */
export function normalizeVocalGender(gender: unknown): "male" | "female" | null {
  const text = typeof gender === "string" ? gender.trim().toLowerCase() : "";
  if (text.startsWith("female")) return "female";
  if (text.startsWith("male")) return "male";
  return null;
}

const MALE_VOCAL_LEAD = "Deep soulful male vocal, baritone delivery, ";
const FEMALE_VOCAL_LEAD = "Female vocal, ";

/**
 * Mureka defaults to female pop when the prompt never names the singer.
 * The gender field alone does not lock it; the prompt text has to.
 */
export function promptWithVocalGender(prompt: string, gender: "male" | "female"): string {
  if (gender === "female") {
    if (/\bfemale vocal\b/i.test(prompt)) return prompt;
    return `${FEMALE_VOCAL_LEAD}${prompt}`;
  }
  if (/\bmale vocal\b|\bbaritone\b/i.test(prompt)) return prompt;
  return `${MALE_VOCAL_LEAD}${prompt}`;
}

type GenerateBody = {
  title?: unknown;
  prompt?: unknown;
  stylePrompt?: unknown;
  style?: unknown;
  lyrics?: unknown;
  lyricsText?: unknown;
  text?: unknown;
  gender?: unknown;
  isInstrumental?: unknown;
  vocalId?: unknown;
  referenceId?: unknown;
  userId?: unknown;
  duration?: unknown;
};

const EMPTY_GENERATION_ERROR = "Generation blocked: No style or lyrics received by backend.";
const LYRICS_REQUIRED_ERROR = "Generation blocked: Lyrics are required.";
const QUEUE_FAILED_ERROR = "Failed to queue the master.";
const PROMPT_MAX_CHARS = 1024;
const LYRICS_MAX_CHARS = 5000;

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function firstAlias(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text) return text;
  }
  return "";
}

function resolvedTitle(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "Untitled";
}

function logGenerationBody(body: GenerateBody): void {
  const safe: Record<string, unknown> = { ...body };
  for (const key of Object.keys(safe)) {
    if (/authorization|token|api[_-]?key|secret|password/i.test(key)) delete safe[key];
  }
  console.log("=== INCOMING GENERATION PAYLOAD ===", safe);
}

type JsonRecord = Record<string, unknown>;

class UpstreamHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withJitter(ms: number): number {
  return ms + Math.random() * 250;
}

function networkDelay(attempt: number): number {
  return withJitter(Math.max(2000, 500 * 2 ** attempt));
}

function retryAfterDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  let delay = 500 * 2 ** attempt;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      delay = seconds * 1000;
    } else {
      const when = Date.parse(header);
      if (Number.isFinite(when)) delay = Math.max(0, when - Date.now());
    }
  }
  return withJitter(Math.max(2000, Math.min(10000, delay)));
}

function upstreamMessage(body: JsonRecord, status: number): string {
  const data = isRecord(body.data) ? body.data : null;
  const message = typeof body.message === "string" ? body.message : "";
  const dataError = data && typeof data.error === "string" ? data.error : "";
  return message || dataError || `HTTP ${status}`;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof UpstreamHttpError) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return err instanceof TypeError;
}

function hasIdOrStatus(body: JsonRecord): boolean {
  return body.id !== undefined || body.status !== undefined;
}

function customerMessage(message: string, fallback: string): string {
  const text = message.trim();
  if (!text || /wavespeed/i.test(text)) return fallback;
  return text;
}

/** One attempt uses a 30s timeout. Network and 429/5xx responses retry; other HTTP errors do not. */
async function fetchJson(
  url: string,
  init: RequestInit,
  retries: number,
  unwrap = true,
): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      let body: JsonRecord;
      try {
        const parsed: unknown = JSON.parse(text);
        body = isRecord(parsed) ? parsed : { message: text };
      } catch {
        body = { message: text };
      }
      const code = body.code;
      const codeOk = code === 200 || code === undefined;
      if (response.ok && codeOk) {
        if (!unwrap) return body;
        if (body.data !== undefined && body.data !== null) return body.data;
        if (hasIdOrStatus(body)) return body;
        if (code === 200) return body;
        throw new UpstreamHttpError(upstreamMessage(body, response.status));
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= retries) throw new UpstreamHttpError(upstreamMessage(body, response.status));
        await sleep(retryAfterDelay(response, attempt));
        continue;
      }
      throw new UpstreamHttpError(upstreamMessage(body, response.status));
    } catch (err) {
      if (!isNetworkError(err) || attempt >= retries) throw err;
      await sleep(networkDelay(attempt));
    }
  }
  throw new UpstreamHttpError("HTTP 0");
}

function vaultClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

const TERMINAL_FAIL = new Set(["failed", "cancelled", "timeout", "deleted"]);

function resultUrl(taskId: string): string {
  return `https://api.wavespeed.ai/api/v3/predictions/${encodeURIComponent(taskId)}/result`;
}

function readResultStatus(body: unknown): string {
  const record = isRecord(body) ? body : null;
  const nested = record && isRecord(record.data) ? record.data : null;
  const status = nested?.status ?? record?.status;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function audioUrl(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("https://")) {
      const bare = text.split(/[?#]/)[0] ?? text;
      if (/\/predictions\/[^/]+\/result\/?$/.test(bare)) return "";
      return text;
    }
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return audioUrl(JSON.parse(text) as unknown);
      } catch {
        return "";
      }
    }
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = audioUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (isRecord(value)) {
    for (const key of ["url", "audio", "audio_url", "wav_url", "wav"]) {
      const found = audioUrl(value[key]);
      if (found) return found;
    }
  }
  return "";
}

function readResultOutput(body: unknown): string {
  const record = isRecord(body) ? body : null;
  const nested = record && isRecord(record.data) ? record.data : null;
  const layers = [nested, record];
  for (const layer of layers) {
    if (!layer) continue;
    for (const candidate of [layer.outputs, layer.output, layer.result, layer.audio_url, layer.url]) {
      const found = audioUrl(candidate);
      if (found) return found;
    }
  }
  return "";
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

/** Title, prompt, and lyrics from a prediction body. Title falls back to "Untitled". */
export function waveSpeedResultMeta(body: unknown): {
  title: string;
  prompt: string | null;
  lyrics: string | null;
} {
  const record = isRecord(body) ? body : null;
  const data = record && isRecord(record.data) ? record.data : null;
  const sources = [
    data,
    data && isRecord(data.input) ? data.input : null,
    data && isRecord(data.output) ? data.output : null,
    record,
    record && isRecord(record.input) ? record.input : null,
    record && isRecord(record.output) ? record.output : null,
  ];
  let title = "";
  let prompt: string | null = null;
  let lyrics: string | null = null;
  for (const source of sources) {
    if (!source) continue;
    if (!title) title = stringField(source.title) ?? "";
    if (!prompt) prompt = stringField(source.prompt);
    if (!lyrics) lyrics = stringField(source.lyrics);
  }
  return { title: title || "Untitled", prompt, lyrics };
}

export function waveSpeedResultStatus(body: unknown): string {
  return readResultStatus(body);
}

export function waveSpeedAudioUrl(body: unknown): string {
  return readResultOutput(body);
}

export function isTerminalWaveSpeedStatus(status: string): boolean {
  return TERMINAL_FAIL.has(status);
}

/** GET the v3 prediction result. The caller-supplied body is not a source for this URL. */
export async function fetchWaveSpeedPrediction(taskId: string): Promise<unknown> {
  const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error("Missing API key");
  return fetchJson(
    resultUrl(taskId),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    RESULT_RETRIES,
    false,
  );
}

async function insertVaultRow(
  job: TrackJob,
  wavUrl: string,
  mp3Url: string,
): Promise<void> {
  // vaulted_tracks.wav_url and mp3_url are NOT NULL. There is no status or style_prompt column.
  // A processing placeholder would fail, so the only insert is this one, after the master is stored.
  if (!job.userId) return;
  const supabase = vaultClient();
  const { error: insertError } = await supabase.from("vaulted_tracks").insert({
    user_id: job.userId,
    title: job.title,
    prompt: job.prompt,
    lyrics: job.lyrics,
    vocal_id_used: job.vocalId,
    wav_url: wavUrl,
    mp3_url: mp3Url,
    task_id: job.taskId,
  });
  if (insertError) throw new Error(insertError.message);
}

async function uploadMasterFiles(
  taskId: string,
  outputUrl: string,
): Promise<{ wavUrl: string; mp3Url: string }> {
  if (!outputUrl.startsWith("https://")) {
    throw new Error("Generation failed upstream");
  }
  const bare = outputUrl.split(/[?#]/)[0] ?? outputUrl;
  if (/\/predictions\/[^/]+\/result\/?$/.test(bare)) {
    throw new Error("Generation failed upstream");
  }
  const wavRes = await fetch(outputUrl);
  if (!wavRes.ok) {
    throw new Error("Generation failed upstream");
  }
  const wavBuffer = Buffer.from(await wavRes.arrayBuffer());
  const encoded = wavToMp3(wavBuffer);

  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const supabase = vaultClient();
  const wavPath = `masters/${taskId}.wav`;
  const cdnBase = `${supabaseUrl}/storage/v1/object/public/${VAULT_BUCKET}`;
  const wavUrl = `${cdnBase}/${wavPath}`;

  if (!isMp3FrameOrId3(encoded)) {
    const wavUpload = await supabase.storage.from(VAULT_BUCKET).upload(wavPath, wavBuffer, {
      contentType: "audio/wav",
      upsert: true,
    });
    if (wavUpload.error) {
      throw new Error(wavUpload.error.message || "Vault upload failed");
    }
    return { wavUrl, mp3Url: wavUrl };
  }

  const mp3Path = `masters/${taskId}.mp3`;
  const [wavUpload, mp3Upload] = await Promise.all([
    supabase.storage.from(VAULT_BUCKET).upload(wavPath, wavBuffer, {
      contentType: "audio/wav",
      upsert: true,
    }),
    supabase.storage.from(VAULT_BUCKET).upload(mp3Path, encoded, {
      contentType: "audio/mpeg",
      upsert: true,
    }),
  ]);
  if (wavUpload.error || mp3Upload.error) {
    throw new Error(wavUpload.error?.message || mp3Upload.error?.message || "Vault upload failed");
  }

  return { wavUrl, mp3Url: `${cdnBase}/${mp3Path}` };
}

async function vaultCompletedWav(
  job: TrackJob,
  outputUrl: string,
): Promise<{ wavUrl: string; mp3Url: string }> {
  const urls = await uploadMasterFiles(job.taskId, outputUrl);
  await insertVaultRow(job, urls.wavUrl, urls.mp3Url);
  return urls;
}

type VaultUrlRow = { wav_url?: string | null; mp3_url?: string | null };

/** Existing masters for this user and task. A second sync must not insert again. */
export async function findVaultedTrack(
  userId: string,
  taskId: string,
): Promise<{ wavUrl: string; mp3Url: string } | null> {
  const supabase = vaultClient();
  const { data, error } = await supabase
    .from("vaulted_tracks")
    .select("wav_url, mp3_url")
    .eq("user_id", userId)
    .eq("task_id", taskId)
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : null) as VaultUrlRow | null;
  const wavUrl = typeof row?.wav_url === "string" ? row.wav_url : "";
  const mp3Url = typeof row?.mp3_url === "string" ? row.mp3_url : "";
  if (!wavUrl || !mp3Url) return null;
  return { wavUrl, mp3Url };
}

/** Download one https master and insert a single vaulted_tracks row. */
export async function storeVaultedMaster(input: {
  taskId: string;
  userId: string;
  title: string;
  prompt: string | null;
  lyrics: string | null;
  outputUrl: string;
}): Promise<{ wavUrl: string; mp3Url: string }> {
  const urls = await uploadMasterFiles(input.taskId, input.outputUrl);
  const supabase = vaultClient();
  const { error: insertError } = await supabase.from("vaulted_tracks").insert({
    user_id: input.userId,
    title: input.title,
    prompt: input.prompt,
    lyrics: input.lyrics,
    vocal_id_used: null,
    wav_url: urls.wavUrl,
    mp3_url: urls.mp3Url,
    task_id: input.taskId,
  });
  if (insertError) throw new Error(insertError.message);
  return urls;
}

/**
 * Confirm the prediction with WaveSpeed, then vault once.
 * The webhook body is not trusted for the audio URL.
 */
export async function settleTrackFromWaveSpeed(taskId: string): Promise<void> {
  const existing = readTrackJob(taskId);
  if (!existing || existing.status !== "processing" || existing.delivering) return;

  const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("[generate] missing API key");
    failTrackJob(taskId, "Missing API key");
    return;
  }

  const pollData = await fetchJson(
    resultUrl(taskId),
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    RESULT_RETRIES,
    false,
  );

  const status = readResultStatus(pollData);
  console.log(`[generate] task ${taskId} status ${status || "pending"}`);
  if (!status || status === "processing" || status === "created" || status === "pending") return;
  if (TERMINAL_FAIL.has(status)) {
    failTrackJob(taskId, "Generation failed upstream");
    return;
  }
  if (status !== "completed") return;

  console.log("[generate] completed task full payload:", JSON.stringify(pollData));
  const outputUrl = readResultOutput(pollData);
  if (!outputUrl.startsWith("https://")) {
    throw new Error(`Task marked completed but no audio URL found in: ${JSON.stringify(pollData)}`);
  }

  const job = beginDelivery(taskId);
  if (!job) return;
  console.log(`[vault] uploading ${outputUrl}`);
  try {
    const urls = await vaultCompletedWav(job, outputUrl);
    completeTrackJob(taskId, urls);
    console.log(`[vault] stored ${taskId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    console.error(`[vault] upload failed ${taskId}`, message || "error");
    failTrackJob(taskId, message || "Generation failed upstream");
  }
}

/** Keep checking after the HTTP response has already returned. Backs off from 2s toward 10s until 60 minutes. */
export async function watchTrack(taskId: string): Promise<void> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let pollDelay = 2000;
  while (Date.now() < deadline) {
    const current = readTrackJob(taskId);
    if (!current || current.status !== "processing") return;
    try {
      await settleTrackFromWaveSpeed(taskId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      console.error("[generate] watch error", message || "error");
    }
    const after = readTrackJob(taskId);
    if (!after || after.status !== "processing") return;
    if (Date.now() >= deadline) break;
    await sleep(pollDelay);
    pollDelay = Math.min(10000, pollDelay + 1000);
  }
  const still = readTrackJob(taskId);
  if (still?.status === "processing") {
    failTrackJob(taskId, "Task hit the 60-minute engine ceiling");
  }
}

const watching = new Set<string>();

function startTrackWatch(taskId: string): void {
  // VITEST=true skips the automatic watch. Tests call watchTrack or settle explicitly.
  // setTimeout detaches the poll from the POST so a browser refresh cannot abort the vault.
  if (process.env.VITEST === "true") return;
  if (watching.has(taskId)) return;
  watching.add(taskId);
  setTimeout(() => {
    void watchTrack(taskId).finally(() => watching.delete(taskId));
  }, 0);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as GenerateBody;
    logGenerationBody(body);
    const {
      gender,
      isInstrumental: rawInstrumental,
      vocalId,
      userId: rawUserId,
    } = body;
    const style = replaceBareConflictingPrompt(
      formatMurekaPrompt(firstAlias(body.prompt, body.stylePrompt, body.style)),
    );
    const rawLyrics = (
      (typeof body.lyrics === "string" ? body.lyrics : "") ||
      (typeof body.lyricsText === "string" ? body.lyricsText : "") ||
      (typeof body.text === "string" ? body.text : "")
    ).trim();
    const isInstrumental = rawInstrumental === true;
    const title = resolvedTitle(body.title);
    const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
    const vocalUsed = vocalId && String(vocalId).trim() !== "" ? String(vocalId).trim() : "";
    const vocalGender = normalizeVocalGender(gender);
    if (!isInstrumental && !rawLyrics) {
      console.error("ABORTED: Vocal lyrics are empty.");
      return Response.json({ error: LYRICS_REQUIRED_ERROR }, { status: 400 });
    }
    const lyrics = formatMurekaLyrics(rawLyrics);
    const lyricText = clipText(lyrics.trim(), LYRICS_MAX_CHARS);
    if (!isInstrumental && !lyricText) {
      console.error("ABORTED: Vocal lyrics are empty.");
      return Response.json({ error: LYRICS_REQUIRED_ERROR }, { status: 400 });
    }
    if (isInstrumental && !style) {
      console.error("ABORTED: Style and lyrics are both empty or undefined!");
      return Response.json({ error: EMPTY_GENERATION_ERROR }, { status: 400 });
    }

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      console.error("[generate] missing API key");
      return Response.json({ error: "Missing API key" }, { status: 500 });
    }

    const endpoint = isInstrumental ? GENERATE_BGM_URL : GENERATE_SONG_URL;
    // duration, seed, webhook, vocal_id, and reference_id stay off this body.
    const payload: {
      output_format: "wav";
      prompt?: string;
      lyrics?: string;
      lyrics_type?: "custom";
      title?: string;
      gender?: "male" | "female";
    } = {
      output_format: "wav",
    };
    if (style) {
      const styled = isInstrumental ? style : promptWithVocalGender(style, vocalGender ?? "male");
      const clipped = clipText(styled.trim(), PROMPT_MAX_CHARS);
      if (clipped) payload.prompt = clipped;
    }
    if (!isInstrumental) {
      payload.title = title || "Untitled";
      payload.lyrics_type = "custom";
      payload.lyrics = lyricText;
      payload.gender = vocalGender ?? "male";
    }
    const prompt = payload.prompt ?? "";

    console.log("=== DISPATCHING TO WAVESPEED ===", payload);
    const submitData = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      SUBMIT_RETRIES,
    );
    const queued = isRecord(submitData) ? submitData : null;
    const taskId = typeof queued?.id === "string" ? queued.id.trim() : "";
    if (!taskId) {
      console.error("[generate] queue response had no id", JSON.stringify(submitData));
      return Response.json({ error: QUEUE_FAILED_ERROR }, { status: 502 });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
      throw new Error("Task submission rejected by upstream");
    }
    console.log(`[generate] WaveSpeed accepted task ${taskId}`);
    rememberTrackJob({
      taskId,
      title,
      prompt,
      lyrics: isInstrumental ? null : lyricText,
      vocalId: vocalUsed || null,
      userId,
      status: "processing",
      delivering: false,
    });
    startTrackWatch(taskId);

    return Response.json({
      success: true,
      status: "pending",
      taskId,
      requestId: taskId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    console.error("[generate] submit failed", message || "error");
    return Response.json(
      { error: customerMessage(message, QUEUE_FAILED_ERROR) },
      { status: 500 },
    );
  }
}
