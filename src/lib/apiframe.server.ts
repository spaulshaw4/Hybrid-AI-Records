/** Replicate music generation client (server-only). Model: minimax/music-2.6 */
import { replicateApiKey, replicateBaseUrl } from "@/lib/ai-provider.server";
import { elevenLabsMusicOutputFormat } from "@/lib/elevenlabs-music-format";
import {
  REPLICATE_COMMUNITY_PREDICTIONS_PATH,
  communityPredictionBody,
  officialModelPredictionsPath,
} from "@/lib/replicate-predictions";
import { engineLog, logEnginePayload, newCorrelationId } from "@/lib/engine-log.server";
import { incCounter, observeBackoff, setGauge } from "@/lib/engine-metrics.server";
import {
  ENGINE_CREDIT_MESSAGE,
  engineCreditErrorMessage,
  looksLikeCreditExhaustion,
} from "@/lib/engine-credits";

export { newCorrelationId };


const MODEL_PREDICTIONS_PATH = officialModelPredictionsPath("minimax/music-2.6");
const PREDICTIONS_PATH = REPLICATE_COMMUNITY_PREDICTIONS_PATH;

export type EngineTarget = { name: string; base: string };

/**
 * Ordered engine targets. The primary base URL can be overridden with
 * MUSIC_ENGINE_BASE_URL; MUSIC_ENGINE_FAILOVER_BASE_URL adds a secondary
 * engine that takes over once the primary's circuit breaker is open.
 */
export function engineTargets(): EngineTarget[] {
  const trim = (value: string) => value.trim().replace(/\/+$/, "");
  const fallbackBase = replicateBaseUrl();
  const primary = trim(process.env['MUSIC_ENGINE_BASE_URL'] || fallbackBase);
  const failover = trim(process.env['MUSIC_ENGINE_FAILOVER_BASE_URL'] || "");
  const targets: EngineTarget[] = [{ name: "primary", base: primary || fallbackBase }];
  if (failover && failover !== primary) targets.push({ name: "failover", base: failover });
  return targets;
}

export type ApiframeTrack = {
  id: string | null;
  title: string | null;
  audioUrl: string | null;
  imageUrl: string | null;
  duration: number | null;
};

export type ApiframeResult = {
  taskId: string | null;
  status: string;
  tracks: ApiframeTrack[];
  raw: unknown;
};

function audioExtension(contentType: string, sourceUrl: string): "mp3" | "wav" | "m4a" | "ogg" {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.includes("wav")) return "wav";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase();
  if (extension === "wav" || extension === "m4a" || extension === "ogg") return extension;
  return "mp3";
}

function looksLikeAudio(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes.slice(0, 12));
  return (
    text.startsWith("RIFF") ||
    text.startsWith("OggS") ||
    text.startsWith("fLaC") ||
    text.slice(4, 8) === "ftyp" ||
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0)
  );
}

/** Copies short-lived engine output into private app storage before its CDN URL expires. */
export async function archiveGeneratedAudio(
  sourceUrl: string,
  userId: string,
  taskId: string,
): Promise<string> {
  let lastError: unknown = null;
  // Transient CDN hiccups must never leave a temporary URL as the stored source.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await archiveOnce(sourceUrl, userId, taskId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The finished track could not be saved for playback.");
}

/** Stores engine output that already arrived as bytes (instant vocal clone). */
export async function archiveGeneratedAudioBytes(
  bytes: Uint8Array,
  userId: string,
  taskId: string,
  contentType = "audio/mpeg",
): Promise<string> {
  if (bytes.byteLength < 256 || !looksLikeAudio(bytes)) {
    throw new Error("The music engine returned an invalid audio file.");
  }
  const extension = contentType.includes("wav") ? "wav" : "mp3";
  const path = `${userId}/${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`;
  const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
  return uploadEngineMaster(bytes, path, extension);
}

async function archiveOnce(sourceUrl: string, userId: string, taskId: string): Promise<string> {
  let response: Response | undefined;
  try {
    response = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    const { describeFetchError } = await import("@/lib/safe-fetch");
    throw new Error(`The finished audio could not be downloaded — ${describeFetchError(error)}.`);
  }
  if (!response) throw new Error("The finished audio could not be downloaded — no response from the storage host.");
  if (!response.ok) throw new Error("The finished audio expired before it could be saved.");
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  if (/^(text\/|application\/(json|problem\+json))/i.test(contentType)) {
    throw new Error("The music engine returned an invalid audio file.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024 || !looksLikeAudio(bytes)) {
    throw new Error("The music engine returned an invalid audio file.");
  }

  const extension = audioExtension(contentType, sourceUrl);
  const path = `${userId}/${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extension}`;
  const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
  return uploadEngineMaster(bytes, path, extension === "wav" ? "wav" : "mp3");
}


function getReplicateCredentials(): { connectionApiKey: string } {
  return { connectionApiKey: replicateApiKey("The music engine") };
}

function collectTracks(payload: any, title: string | null): ApiframeTrack[] {
  const output = payload?.output;
  const urls: string[] = Array.isArray(output)
    ? output.filter((value: unknown): value is string => typeof value === "string" && value.startsWith("http"))
    : typeof output === "string" && output.startsWith("http")
      ? [output]
      : typeof output?.audio === "string" && String(output.audio).startsWith("http")
        ? [output.audio]
        : typeof output?.url === "string" && String(output.url).startsWith("http")
          ? [output.url]
          : [];

  return urls.map((url, index) => ({
    id: `${payload?.id ?? "prediction"}-${index}`,
    title,
    audioUrl: url,
    imageUrl: null,
    duration: null,
  }));
}

function normalize(payload: any, title: string | null = null): ApiframeResult {
  return {
    taskId: payload?.id ?? null,
    status: String(payload?.status ?? "starting"),
    tracks: collectTracks(payload, title),
    raw: payload,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const envInt = (name: string, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

/** Retry/backoff/circuit-breaker knobs (env-configurable, safe defaults). */
function retryConfig() {
  return {
    attempts: envInt("MUSIC_ENGINE_RETRY_ATTEMPTS", 3, 1, 6),
    baseDelayMs: envInt("MUSIC_ENGINE_RETRY_BASE_MS", 600, 50, 10_000),
    maxDelayMs: envInt("MUSIC_ENGINE_RETRY_MAX_MS", 8_000, 100, 60_000),
    failureThreshold: envInt("MUSIC_ENGINE_BREAKER_FAILURES", 5, 1, 50),
    cooldownMs: envInt("MUSIC_ENGINE_BREAKER_COOLDOWN_MS", 30_000, 1_000, 600_000),
  };
}

/** Full-jitter exponential backoff: random in [0, min(max, base * 2^attempt)]. */
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/** In-memory circuit breakers, one per engine target. */
type BreakerState = { failures: number; openedAt: number };
const breakers = new Map<string, BreakerState>();

function getBreaker(target: string): BreakerState {
  let state = breakers.get(target);
  if (!state) {
    state = { failures: 0, openedAt: 0 };
    breakers.set(target, state);
  }
  return state;
}

export function musicEngineBreakerState() {
  const { failureThreshold, cooldownMs } = retryConfig();
  const targets = engineTargets().map((target) => {
    const state = getBreaker(target.name);
    const open = state.openedAt > 0 && Date.now() - state.openedAt < cooldownMs;
    return {
      target: target.name,
      base: target.base,
      open,
      failures: state.failures,
      retryAfterMs: open ? cooldownMs - (Date.now() - state.openedAt) : 0,
    };
  });
  const primary = targets[0]!;
  return {
    open: targets.every((t) => t.open),
    failures: primary.failures,
    failureThreshold,
    retryAfterMs: primary.retryAfterMs,
    failoverConfigured: targets.length > 1,
    targets,
  };
}

export function resetMusicEngineBreaker() {
  breakers.clear();
}

function recordSuccess(target: string, correlationId: string) {
  const state = getBreaker(target);
  const hadFailures = state.failures > 0 || state.openedAt > 0;
  state.failures = 0;
  state.openedAt = 0;
  setGauge("music_engine_breaker_failures", 0, { target });
  setGauge("music_engine_breaker_open", 0, { target });
  if (hadFailures) {
    incCounter("music_engine_breaker_transitions_total", { target, to: "closed" });
    engineLog("info", "breaker.closed", correlationId, { target, from: "half-open" });
  }
}

function recordFailure(
  target: string,
  failureThreshold: number,
  correlationId: string,
  reason: string,
) {
  const state = getBreaker(target);
  state.failures += 1;
  setGauge("music_engine_breaker_failures", state.failures, { target });
  engineLog("warn", "breaker.failure", correlationId, {
    target,
    failures: state.failures,
    failureThreshold,
    reason,
  });
  if (state.failures >= failureThreshold && state.openedAt === 0) {
    state.openedAt = Date.now();
    setGauge("music_engine_breaker_open", 1, { target });
    incCounter("music_engine_breaker_transitions_total", { target, to: "open" });
    engineLog("error", "breaker.opened", correlationId, {
      target,
      failures: state.failures,
      failureThreshold,
    });
  }
}


/**
 * Transient gateway hiccups (resets, 502/503/504) are retried with jittered
 * backoff. When a target's breaker stays open past its threshold, the request
 * fails over to the next configured engine base URL instead of short-circuiting.
 */
async function fetchWithRetry(
  pathOrUrl: string,
  init: RequestInit,
  correlationId: string,
): Promise<Response> {
  const { attempts, baseDelayMs, maxDelayMs, failureThreshold, cooldownMs } = retryConfig();
  const absolute = /^https?:\/\//i.test(pathOrUrl);
  const targets: EngineTarget[] = absolute
    ? [{ name: "gateway", base: "" }]
    : engineTargets();

  let lastError: unknown = null;
  let openTarget: { retryAfterMs: number } | null = null;

  for (const target of targets) {
    const url = absolute ? pathOrUrl : `${target.base}${pathOrUrl}`;
    const path = new URL(url).pathname;
    const state = getBreaker(target.name);

    if (state.openedAt > 0) {
      const elapsed = Date.now() - state.openedAt;
      if (elapsed < cooldownMs) {
        const retryAfterMs = cooldownMs - elapsed;
        openTarget = openTarget ?? { retryAfterMs };
        incCounter("music_engine_requests_total", { target: target.name, outcome: "short_circuit" });
        engineLog("warn", "breaker.short_circuit", correlationId, {
          target: target.name,
          path,
          retryAfterMs,
        });
        continue; // try the next configured engine, if any
      }
      // Half-open: allow a single probe through.
      state.openedAt = 0;
      state.failures = failureThreshold - 1;
      setGauge("music_engine_breaker_open", 0, { target: target.name });
      incCounter("music_engine_breaker_transitions_total", { target: target.name, to: "half_open" });
      engineLog("info", "breaker.half_open", correlationId, { target: target.name, path, cooldownMs });
    }

    if (target !== targets[0]) {
      incCounter("music_engine_failovers_total", { from: targets[0]!.name, to: target.name });
      engineLog("warn", "engine.failover", correlationId, {
        from: targets[0]!.name,
        to: target.name,
        base: target.base,
      });
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        const delayMs = backoffDelay(attempt - 1, baseDelayMs, maxDelayMs);
        incCounter("music_engine_retries_total", { target: target.name });
        observeBackoff("music_engine_backoff_delay_seconds", delayMs / 1000, { target: target.name });
        engineLog("warn", "request.retry", correlationId, {
          target: target.name,
          path,
          attempt,
          attempts,
          delayMs,
          reason: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown"),
        });
        await sleep(delayMs);
      }
      const startedAt = Date.now();
      engineLog("info", "request.attempt", correlationId, {
        target: target.name,
        path,
        method: init.method ?? "GET",
        attempt,
        attempts,
      });
      try {
        const requestTimeoutMs = envInt("MUSIC_ENGINE_HTTP_TIMEOUT_MS", 240_000, 30_000, 900_000);
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
        // Guard an undefined response before any status property is read.
        if (!response) throw new Error("no response from the music engine");
        const durationMs = Date.now() - startedAt;
        if ([502, 503, 504].includes(response.status)) {
          lastError = new Error(`upstream ${response.status}`);
          incCounter("music_engine_requests_total", {
            target: target.name,
            outcome: "upstream_error",
          });
          engineLog("warn", "request.upstream_error", correlationId, {
            target: target.name,
            path,
            attempt,
            status: response.status,
            durationMs,
          });
          if (attempt < attempts) continue;
          recordFailure(target.name, failureThreshold, correlationId, `upstream ${response.status}`);
          if (target !== targets[targets.length - 1]) break; // fail over
          incCounter("music_engine_calls_total", { result: "failure" });
          return response;
        }
        incCounter("music_engine_requests_total", { target: target.name, outcome: "success" });
        engineLog("info", "request.response", correlationId, {
          target: target.name,
          path,
          attempt,
          status: response.status,
          durationMs,
        });
        recordSuccess(target.name, correlationId);
        incCounter("music_engine_calls_total", { result: "success" });
        return response;

      } catch (rawError) {
        const timedOut =
          rawError instanceof Error &&
          (rawError.name === "TimeoutError" || rawError.name === "AbortError");
        const error = timedOut
          ? new Error("the engine took too long to respond")
          : rawError;
        lastError = error;
        incCounter("music_engine_requests_total", {
          target: target.name,
          outcome: timedOut ? "timeout" : "network_error",
        });

        engineLog("error", "request.network_error", correlationId, {
          target: target.name,
          path,
          attempt,
          durationMs: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        });
        if (attempt === attempts) {
          recordFailure(
            target.name,
            failureThreshold,
            correlationId,
            error instanceof Error ? error.message : "connection reset",
          );
        }
      }
    }
  }

  if (!lastError && openTarget) {
    incCounter("music_engine_calls_total", { result: "short_circuit" });
    throw new Error(
      `Music engine: temporarily unavailable while it recovers. Try again in ${Math.ceil(openTarget.retryAfterMs / 1000)}s.`,
    );
  }
  incCounter("music_engine_calls_total", { result: "failure" });
  throw new Error(
    `Music engine: temporarily unreachable (${lastError instanceof Error ? lastError.message : "connection reset"}). Please try again.`,
  );

}

async function call(
  pathOrUrl: string,
  init: RequestInit,
  title: string | null = null,
  correlationId: string = newCorrelationId(),
): Promise<ApiframeResult> {
  const { connectionApiKey } = getReplicateCredentials();
  const response = await fetchWithRetry(pathOrUrl, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${connectionApiKey}`,
      ...(init.headers ?? {}),
      "X-Correlation-Id": correlationId,
    },
  }, correlationId);


  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { detail: text.slice(0, 500) };
  }

  if (response.status === 401) {
    engineLog("error", "call.unauthorized", correlationId, { status: 401 });
    throw new Error("Music engine connection needs to be reauthorized.");
  }
  // Credit exhaustion is its own outcome, not a generic failure: the caller
  // must be able to tell the artist their tokens were NOT spent.
  if (looksLikeCreditExhaustion(response.status, text)) {
    engineLog("error", "call.no_credit", correlationId, { status: response.status });
    throw new Error(engineCreditErrorMessage());
  }

  if (!response.ok) {
    const message = payload?.detail ?? payload?.title ?? payload?.error ?? `Request failed (${response.status})`;
    engineLog("error", "call.failed", correlationId, { status: response.status, message });
    throw new Error(`Music engine: ${message}`);
  }


  const result = normalize(payload, title);
  if (result.status === "failed" || result.status === "canceled") {
    engineLog("error", "call.generation_failed", correlationId, {
      taskId: result.taskId,
      status: result.status,
    });
    const detail = String(payload?.error ?? "generation failed");
    // Providers sometimes report exhausted credits inside a 200 body.
    if (looksLikeCreditExhaustion(402, detail) && /credit|billing|quota/i.test(detail)) {
      throw new Error(engineCreditErrorMessage());
    }
    throw new Error(`Music engine: ${detail}`);
  }

  engineLog("info", "call.ok", correlationId, {
    taskId: result.taskId,
    status: result.status,
    trackCount: result.tracks.length,
  });
  return result;
}

export type ApiframeGenerateInput = {
  prompt: string;
  title: string;
  style: string;
  lyrics: string;
  instrumental: boolean;
  customMode: boolean;
  model: string;
  audioFormat?: "mp3" | "wav";
  voiceId?: string;
  referenceAudioUrl?: string;
  preserveUserPrompt?: boolean;
  /** Lyric-language picker value ("auto", "lt", "en-ng", "custom", …). */
  language?: string;
  /** Free-text language when the picker is set to "custom". */
  customLanguage?: string;
};

export async function requestApiframeGeneration(
  input: ApiframeGenerateInput,
  correlationId: string = newCorrelationId("gen"),
): Promise<ApiframeResult> {
  const {
    buildEnginePrompt,
    buildInstrumentalEnginePrompt,
    stripInstrumentalTerms,
    structureLyrics,
  } = await import("./vocal-prompt");
  const { applyDirectiveToPrompt, normalizeLyricUnicode, resolveLanguageProfile } = await import(
    "./engine-language"
  );
  const { auditDirectivePlacement, stripDirectiveFromLyrics } = await import(
    "./engine-directive-guard"
  );
  const { buildMiniMaxPayload } = await import("./minimax-payload");
  const { concatStylePromptWithLyrics, isDynamicStylePrompt, logApiPayload } = await import(
    "./generation-style-prompt"
  );


  engineLog("info", "generate.start", correlationId, {
    model: input.model,
    customMode: input.customMode,
    promptLength: input.prompt.length,
    lyricsLength: input.lyrics.length,
    language: input.language ?? "auto",
    voiceId: input.voiceId ?? null,
  });

  const instrumental = input.instrumental === true;
  const audioFormat = input.audioFormat === "wav" ? "wav" : "mp3";

  // Vocal tracks: strip any instrumental phrasing from the brief.
  const cleanPrompt = stripInstrumentalTerms(input.prompt);
  const cleanStyle = stripInstrumentalTerms(input.style);

  // Repair encoding before anything else reads the lyrics: a mangled diacritic
  // here is a mispronounced word in the master, and it would also defeat the
  // language auto-detection below.
  const submittedLyrics = instrumental ? "" : normalizeLyricUnicode(input.lyrics);

  // Resolve the target language from the picker, cross-checked against the
  // characters actually present in the lyrics.
  let profile = resolveLanguageProfile(input.language, input.customLanguage, submittedLyrics);

  // No lyrics supplied? Have Gemini write a 2-verse / 1-chorus set first — in
  // the requested language, so the vocal and the words agree.
  let rawLyrics = instrumental ? "" : stripInstrumentalTerms(submittedLyrics);
  if (!instrumental && !rawLyrics) {
    const { writeLyrics } = await import("./lyrics.server");
    engineLog("info", "generate.lyrics.autowrite", correlationId, {
      language: profile?.name ?? "English",
    });
    rawLyrics = normalizeLyricUnicode(
      await writeLyrics({
        concept: cleanPrompt || input.title || "an original hard-edged song",
        style: cleanStyle || undefined,
        title: input.title || undefined,
        language: profile?.native ? `${profile.name} (${profile.native})` : profile?.name,
      }),
    );
    // Written lyrics can land in a different language than requested; re-resolve.
    profile = resolveLanguageProfile(input.language, input.customLanguage, rawLyrics) ?? profile;
  }

  const structured = instrumental ? "" : normalizeLyricUnicode(structureLyrics(rawLyrics));
  // Auto-written lyrics can echo the directive back; scrub before sending.
  const lyrics = instrumental
    ? ""
    : stripDirectiveFromLyrics(structured, profile, instrumental);
  if (!instrumental && !lyrics) throw new Error("Vocal lyrics are required to generate a master track.");

  // Strict separation: style/genre (never lyric text) goes to `prompt`. The
  // language directive is style guidance, so it belongs here too — it tells the
  // model how to pronounce the lyrics without ever being sung itself.
  const preserveUserPrompt =
    input.preserveUserPrompt === true || isDynamicStylePrompt(input.prompt) || isDynamicStylePrompt(input.style);
  const userStyle = preserveUserPrompt ? input.prompt.trim() || input.style.trim() : "";
  const basePrompt = preserveUserPrompt
    ? userStyle
    : instrumental
      ? buildInstrumentalEnginePrompt(cleanStyle, cleanPrompt)
      : buildEnginePrompt(cleanStyle, cleanPrompt);
  // Instrumentals get the no-vocals variant of the directive.
  const prompt = applyDirectiveToPrompt(basePrompt, profile, instrumental);

  const audit = auditDirectivePlacement({ prompt, lyrics, profile, instrumental });
  if (audit.violations.length) {
    engineLog("error", "generate.directive.violation", correlationId, {
      violations: audit.violations,
      instrumental,
      language: profile?.id ?? "en",
    });
  }

  engineLog("info", "generate.vocal.enforced", correlationId, {
    lyricsLength: lyrics.length,
    promptLength: prompt.length,
    instrumental,
    language: profile?.id ?? "en",
    directiveInPrompt: audit.presentInPrompt,
    directiveInLyrics: audit.leakedIntoLyrics,
  });


  // Build the final Replicate-compatible payload through the universal helper.
  const payload = buildMiniMaxPayload({
    prompt,
    lyrics,
    language: input.language,
    customLanguage: input.customLanguage,
    genre: preserveUserPrompt ? undefined : cleanStyle || undefined,
    instrumental,
    audioFormat,
    voiceId: input.voiceId,
  });

  const body = { input: payload.input };

  logApiPayload({
    ...body,
    prompt: concatStylePromptWithLyrics(prompt, lyrics),
    lyrics,
    voice_id: input.voiceId ?? null,
    reference_audio: input.referenceAudioUrl ?? null,
    settings: payload.settings,
  });

  logEnginePayload(correlationId, {
    prompt,
    lyrics,
    instrumental,
    model: "minimax/music-2.6",
    audioFormat,
  });




  return call(
    MODEL_PREDICTIONS_PATH,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    input.title || null,
    correlationId,
  );
}

export type ElevenLabsMusicInput = {
  prompt: string;
  title?: string;
  /** Target length in milliseconds (10s–5min on the model). */
  musicLengthMs?: number;
  instrumental?: boolean;
  audioFormat?: "mp3" | "wav";
};

const ELEVENLABS_MUSIC_PATH = officialModelPredictionsPath("elevenlabs/music");

/**
 * Second engine: ElevenLabs Music, reached through the same Replicate gateway
 * connection as MiniMax, so retries, the circuit breaker and credit-exhaustion
 * handling all behave identically. Poll with `fetchApiframeTask`.
 */
export async function requestElevenLabsMusic(
  input: ElevenLabsMusicInput,
  correlationId: string = newCorrelationId("gen-11l"),
): Promise<ApiframeResult> {
  const lengthMs = Math.min(300_000, Math.max(10_000, Math.round(input.musicLengthMs ?? 30_000)));
  const body = {
    input: {
      prompt: input.prompt,
      music_length_ms: lengthMs,
      force_instrumental: input.instrumental === true,
      output_format: elevenLabsMusicOutputFormat(input.audioFormat),
    },
  };

  const { logApiPayload } = await import("./generation-style-prompt");
  logApiPayload(body);

  engineLog("info", "generate.elevenlabs.start", correlationId, {
    promptLength: input.prompt.length,
    lengthMs,
    instrumental: input.instrumental === true,
  });

  return call(
    ELEVENLABS_MUSIC_PATH,
    { method: "POST", body: JSON.stringify(body) },
    input.title || null,
    correlationId,
  );
}


export async function fetchApiframeTask(
  taskId: string,
  correlationId: string = newCorrelationId("poll"),
): Promise<ApiframeResult> {
  engineLog("info", "poll.start", correlationId, { taskId });
  return call(
    `${PREDICTIONS_PATH}/${encodeURIComponent(taskId)}`,
    { method: "GET" },
    null,
    correlationId,
  );
}

/** Poll until a prediction succeeds, fails, or times out. */
export async function waitForMusicPrediction(
  taskId: string,
  correlationId: string,
  timeoutMs = 480_000,
): Promise<ApiframeResult> {
  const started = Date.now();
  let delay = 1500;
  for (;;) {
    const result = await fetchApiframeTask(taskId, correlationId);
    if (result.status === "succeeded") return result;
    if (result.status === "failed" || result.status === "canceled") {
      throw new Error(`Music engine: ${result.status}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("Music engine: this render timed out. Try a shorter length.");
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.25), 5000);
  }
}

const communityVersionCache = new Map<string, { id: string; at: number }>();
const COMMUNITY_VERSION_TTL_MS = 10 * 60 * 1000;

/** Latest runnable version hash for a community model (`owner/name`). */
async function resolveCommunityModelVersion(
  model: string,
  correlationId: string,
): Promise<string> {
  const cached = communityVersionCache.get(model);
  if (cached && Date.now() - cached.at < COMMUNITY_VERSION_TTL_MS) return cached.id;

  const { connectionApiKey } = getReplicateCredentials();
  const response = await fetchWithRetry(
    `/models/${model}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${connectionApiKey}`,
        Accept: "application/json",
      },
    },
    correlationId,
  );
  if (!response.ok) {
    throw new Error("Music engine: the vocal model could not be loaded.");
  }
  const body = (await response.json()) as { latest_version?: { id?: string } };
  const id = body.latest_version?.id;
  if (!id) throw new Error("Music engine: the vocal model has no runnable version.");
  communityVersionCache.set(model, { id, at: Date.now() });
  return id;
}

export type AceStepGenerateInput = {
  prompt: string;
  lyrics: string;
  durationSeconds: number;
  audioFormat?: "mp3" | "wav";
  title?: string;
  bpm?: number;
  voiceId?: string;
  referenceAudioUrl?: string;
};

/** Fish Audio ACE-Step 1.5 — vocal stems and arrangement. */
export async function requestAceStepGeneration(
  input: AceStepGenerateInput,
  correlationId: string = newCorrelationId("gen-ace"),
): Promise<ApiframeResult> {
  const { ACE_STEP_MODEL, buildAceStepPayload } = await import("./ace-step-payload");
  const { concatStylePromptWithLyrics, logApiPayload } = await import("./generation-style-prompt");
  const payload = buildAceStepPayload({
    prompt: input.prompt,
    lyrics: input.lyrics,
    durationSeconds: input.durationSeconds,
    audioFormat: input.audioFormat,
    bpm: input.bpm,
    voiceId: input.voiceId,
    referenceAudioUrl: input.referenceAudioUrl,
  });
  const version = await resolveCommunityModelVersion(ACE_STEP_MODEL, correlationId);
  const { voice_id: aceVoiceId, ...aceInput } = payload.input;
  const wireBody = communityPredictionBody(version, aceInput);
  logApiPayload({
    ...wireBody,
    prompt: concatStylePromptWithLyrics(payload.input.prompt, payload.input.lyrics),
    lyrics: payload.input.lyrics,
    voice_id: input.voiceId ?? aceVoiceId ?? null,
    reference_audio: input.referenceAudioUrl ?? payload.input.reference_audio ?? null,
  });
  engineLog("info", "generate.acestep.start", correlationId, {
    promptLength: payload.input.prompt.length,
    lyricsLength: payload.input.lyrics.length,
    duration: payload.input.duration,
    version,
    voiceId: input.voiceId ?? null,
  });
  return call(
    REPLICATE_COMMUNITY_PREDICTIONS_PATH,
    {
      method: "POST",
      body: JSON.stringify(wireBody),
    },
    input.title || null,
    correlationId,
  );
}

/**
 * Lightweight preflight: verifies the engine connection is reachable without
 * starting a generation, so the studio can warn before a user spends a token.
 */
export async function checkApiframeHealth(
  correlationId: string = newCorrelationId("health"),
): Promise<{ ok: boolean; reason: string | null; creditsExhausted: boolean }> {
  engineLog("info", "health.start", correlationId, musicEngineBreakerState());
  let credentials: { connectionApiKey: string };
  try {
    credentials = getReplicateCredentials();
  } catch {
    engineLog("error", "health.unconfigured", correlationId);
    return {
      ok: false,
      reason: "The music engine connection is not configured yet.",
      creditsExhausted: false,
    };
  }

  try {
    const response = await fetchWithRetry(
      `${replicateBaseUrl()}/account`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credentials.connectionApiKey}`,
          "X-Correlation-Id": correlationId,
        },
      },
      correlationId,
    );

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: "The music engine connection needs to be reauthorized.",
        creditsExhausted: false,
      };
    }
    const text = await response.text();
    if (looksLikeCreditExhaustion(response.status, text)) {
      return { ok: false, reason: ENGINE_CREDIT_MESSAGE, creditsExhausted: true };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `The music engine is not responding (${response.status}).`,
        creditsExhausted: false,
      };
    }
    let body: { outcome?: string; error?: string } | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (body?.outcome === "failed") {
      return {
        ok: false,
        reason: "The music engine rejected our connection credentials.",
        creditsExhausted: false,
      };
    }
    engineLog("info", "health.ok", correlationId);
    return { ok: true, reason: null, creditsExhausted: false };
  } catch (error) {
    engineLog("error", "health.unreachable", correlationId, {
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: "The music engine is temporarily unreachable.",
      creditsExhausted: false,
    };
  }

}
