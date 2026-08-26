"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronDown, Download, HelpCircle, Loader2, Minus, Pause, Play, Plus, RefreshCw, Search, Share2, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { LegalDisclaimer } from "@/components/LegalDisclaimer";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useReturnFocus } from "@/hooks/use-return-focus";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TokenStore } from "@/components/TokenStore";
import { QuickVocalRecorder } from "@/components/QuickVocalRecorder";
import { AudioVault } from "@/components/AudioVault";

import { supabase } from "@/integrations/supabase/client";
import { DEV_TEST_TOKEN_BALANCE, isDevAuthBypass } from "@/lib/dev-auth";

/** Temporary live-test escape hatch — set in DevTools: localStorage.hybrid:allowTokenless = "1" */
function allowTokenlessGenerate(): boolean {
  if (isDevAuthBypass()) return true;
  if (import.meta.env.VITE_HYBRID_ALLOW_TOKENLESS_GENERATE === "1") return true;
  if (import.meta.env.VITE_HYBRID_ALLOW_TOKENLESS_GENERATE === "true") return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("hybrid:allowTokenless") === "1";
  } catch {
    return false;
  }
}

import { checkEngineHealth } from "@/lib/apiframe-music.functions";
import { checkStatus } from "@/lib/generate-status-fetch";
import { streamStudioGenerate } from "@/lib/studio-generate-fetch";
import { MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";
import {
  getEngineBreakerStatus,
  type EngineBreakerStatus,
} from "@/lib/engine-health.functions";

import {
  ENGINE_CREDIT_MESSAGE,
  isEngineCreditsError,
  readableEngineError,
} from "@/lib/engine-credits";
import { getTokenBalance, spendTokens } from "@/lib/tokens.functions";
import { generateVocalPrompt } from "@/lib/lyrics-ai.functions";
import { repairLyricStructure } from "@/lib/lyric-repair";
import {
  DEFAULT_LYRIC_LANGUAGE,
  isValidLyricLanguage,
  LYRIC_LANGUAGES,
  lyricLanguageInstruction,
  type LyricLanguage,
} from "@/lib/lyric-languages";
import { explainEngineFailure } from "@/lib/engine-failure";
import {
  readStoredVocalConsent,
  VOCAL_CONSENT_CHECK_ID,
  VOCAL_SOURCE_NAME,
  type VocalSourceMode,
} from "@/lib/vocal-consent";
import {
  CORE_STYLE_SELECT_ID,
  DEFAULT_AI_VOCAL_SELECT_ID,
  GENERATE_TRACK_BTN_ID,
  getValidatedStudioPayload,
  SONG_LYRICS_INPUT_ID,
  STUDIO_CUSTOM_CONSENT_REQUIRED,
  usesCustomVocal,
  usesDefaultAiVocal,
  AI_VOCAL_STYLING_ID,
  VOCAL_SOUND_CONTROLS_ID,
  VOCAL_GENDER_GROUP_ID,
  VIDEO_PROMPT_INPUT_ID,
  type ValidatedStudioPayload,
} from "@/lib/studio-payload";
import { refreshTrackAudioUrl } from "@/lib/track-refresh.functions";
import {
  createStudioTrack,
  finalizeStudioTrack,
  listStudioTracks,
} from "@/lib/studio-tracks.functions";
import {
  createUserVaultTrack,
  finalizeUserVaultTrack,
} from "@/lib/user-vault.functions";
import { fetchVaultTracks as fetchUserVaultTracks, notifyVaultOfNewGeneration } from "@/lib/vault-client";
import { hybridTrackDownloadFileName } from "@/lib/track-download-name";

import { hybridMasterFileName, masterWavFromUrl } from "@/lib/audio-mixdown";
import { abortableBarrier, abortableDelay, isGenerationAborted } from "@/lib/generation-abort";
import {
  PIPELINE_PROGRESS,
  labelForProgressStage,
  reportPipelineProgress,
} from "@/lib/pipeline-progress";
import {
  PipelineGate,
  PIPELINE_COMPLETE,
  PIPELINE_GATE_ORDER,
  getGateNameFromFlag,
  hasPassedGate,
  percentFromGateMask,
  progressStageFromGateFlag,
} from "@/lib/pipeline-flags";
import { wait } from "@/lib/studio-retry";
import {
  cacheStudioStemBlobs,
  revokeStemObjectUrls,
  stemObjectUrl,
  type StemKind,
} from "@/lib/studio-stem-cache";
import {
  clearEngineDraft,
  draftHasContent,
  readEngineDraft,
  writeEngineDraft,
  type EngineDraft,
} from "@/lib/engine-draft";
import { notifyGenerationFailed } from "@/lib/notifications.functions";
import { NotificationBell, refreshNotifications } from "@/components/NotificationBell";
import {
  
  VOCAL_STYLE_GROUPS,
  formatLyricBlocks,
  vocalProfileLabel,
} from "@/lib/vocal-presets";
import { isLocalVocalProfileId } from "@/lib/vocal-profile-store";
import { uploadVoiceSample } from "@/lib/voice-sample-upload";
import {
  DEFAULT_TARGET_DURATION_SECONDS,
  MAX_TARGET_DURATION_SECONDS,
  MIN_TARGET_DURATION_SECONDS,
  TARGET_DURATION_STEP_SECONDS,
  arrangeLyricsForDuration,
  formatDuration,
  snapTargetDuration,
} from "@/lib/track-length";
import {
  DEFAULT_BPM,
  DEFAULT_INFLUENCE,
  DEFAULT_STYLE_INFLUENCE,
  DEFAULT_WEIRDNESS,
  MAX_BPM,
  MAX_INFLUENCE,
  MAX_STYLE_INFLUENCE,
  MAX_WEIRDNESS,
  MIN_BPM,
  MIN_INFLUENCE,
  MIN_STYLE_INFLUENCE,
  MIN_WEIRDNESS,
  clampBpm,
  clampInfluence,
  clampStyleInfluence,
  clampWeirdness,
  styleInfluenceLabel,
  weirdnessToTemperature,
} from "@/lib/engine-controls";
import { presetForGenres } from "@/lib/genre-engine-presets";




/** Quick style chips — one tap sets the sound of the master track. */
const STYLE_CHIPS = [
  "Heavy Rock",
  "Nu-Metal",
  "Rap-Rock",
  "Cinematic",
  "Trap",
  "Hybrid Orchestral",
  "Industrial",
  "Acoustic",
] as const;

const STUDIO_STEPS = [
  { id: "write", label: "Title & Lyrics" },
  { id: "style", label: "Sound & Style" },
  { id: "vocals", label: "Vocals" },
  { id: "generate", label: "Fine-tune & Generate" },
] as const;

const ENGINE_DROPDOWN_CLASS =
  "engine-opaque-menu z-50 flex max-h-80 w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden border border-zinc-800 bg-zinc-950 p-2 text-zinc-100 shadow-2xl";

const STEP1_INCOMPLETE_MESSAGE = "Add a title and lyrics to continue.";

function StudioLanguageSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: LyricLanguage;
  onChange: (next: string) => void;
}) {
  return (
    <select
      id={id}
      name="language"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label="Language"
      className="h-12 w-full cursor-pointer rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-100 shadow-sm outline-none transition-colors hover:border-primary/60 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {LYRIC_LANGUAGES.map((l) => (
        <option key={l.value} value={l.value} className="bg-zinc-950 text-zinc-100">
          {l.label}
        </option>
      ))}
    </select>
  );
}

/** Full genre catalog grouped for the Core style dropdown. */
const GENRE_OPTIONS = [
  {
    group: "Pop & Electronic",
    genres: [
      "Pop",
      "Dance Pop",
      "Electropop",
      "Synthwave",
      "EDM",
      "House",
      "Future Bass",
      "Hyperpop",
      "Techno",
      "Trance",
    ],
  },
  {
    group: "Rock & Metal",
    genres: [
      "Heavy Rock",
      "Hard Rock",
      "Alternative Rock",
      "Nu-Metal",
      "Metalcore",
      "Punk",
      "Post-Hardcore",
      "Industrial Rock",
      "Progressive Rock",
      "Classic Rock",
    ],
  },
  {
    group: "Hip-Hop & R&B",
    genres: [
      "Hip-Hop",
      "Trap",
      "Boom Bap",
      "Drill",
      "Cloud Rap",
      "R&B",
      "Soul",
      "Neo-Soul",
      "Afrobeats",
      "Dancehall",
    ],
  },
  {
    group: "Country & Roots",
    genres: [
      "Country",
      "Outlaw Country",
      "Folk",
      "Americana",
      "Bluegrass",
      "Blues",
      "Gospel",
      "Southern Rock",
    ],
  },
  {
    group: "Cinematic & World",
    genres: [
      "Cinematic",
      "Hybrid Orchestral",
      "Latin Pop",
      "Reggaeton",
      "Reggae",
      "K-Pop",
      "J-Pop",
      "Bollywood",
      "Middle Eastern",
      "Celtic",
      "African",
      "Tropical",
    ],
  },
  {
    group: "Alternative & Experimental",
    genres: [
      "Alternative",
      "Indie",
      "Lo-Fi",
      "Ambient",
      "Trip-Hop",
      "Downtempo",
      "Experimental",
      "Noise",
      "Glitch",
      "Psychedelic",
    ],
  },
] as const;


/** Inline `--fill` percentage that drives the fiery slider active track. */
function sliderFill(value: number, min: number, max: number): CSSProperties {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return { "--fill": `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties;
}

/** Gender presets are mutually exclusive in the vocals picker. */
const GENDER_PRESETS = ["Male Vocal", "Female Vocal"] as const;

type SelectedVocalGender = "" | "m" | "f";

const VOCAL_GENDER_OPTIONS = [
  { value: "" as const, label: "Auto / Any", tag: null },
  { value: "m" as const, label: "Male", tag: "m" },
  { value: "f" as const, label: "Female", tag: "f" },
] as const;

function vocalGenderTagLabel(value: string | undefined): string {
  if (value === "m" || value === "Male") return "Male (m)";
  if (value === "f" || value === "Female") return "Female (f)";
  return "Auto / Any";
}


const PROMPT_MAX = 6000;
const POLL_INTERVAL_MS = 4000;
// Full-length renders regularly run well past ten minutes; the UI stays
// attached for the whole window instead of declaring a failure early.
const POLL_TIMEOUT_MS = 25 * 60 * 1000;
/** Consecutive poll errors tolerated before a run is treated as failed. */
const POLL_MAX_CONSECUTIVE_ERRORS = 5;
const HISTORY_KEY = "hybrid.studio.recent";
const LANGUAGE_KEY = "hybrid.studio.language";
const CUSTOM_LANGUAGE_KEY = "hybrid.studio.customLanguage";
const HISTORY_MAX = 500;
const PENDING_KEY = "hybrid.studio.pending";

/** An engine render that is still running on the server. */
type PendingJob = {
  taskId: string;
  runId: string;
  vaultId: string | null;
  title: string;
  styleLine: string;
  vocalProfile: string;
  startedAt: number;
};

function savePendingJob(job: PendingJob) {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(job));
  } catch {
    /* storage unavailable — the run still finishes in this tab */
  }
}

function clearPendingJob() {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Reads the saved in-flight job.
 * `allowStale` returns jobs past the poll window too, so the cleanup sweep can
 * close them out properly instead of silently dropping them.
 */
function readPendingJob(allowStale = false): PendingJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const job = JSON.parse(raw) as Partial<PendingJob>;
    if (typeof job?.taskId !== "string" || typeof job?.startedAt !== "number") return null;
    // Anything older than the poll window is long gone.
    if (!allowStale && Date.now() - job.startedAt > POLL_TIMEOUT_MS) {
      clearPendingJob();
      return null;
    }
    return {
      taskId: job.taskId,
      runId: typeof job.runId === "string" ? job.runId : job.taskId,
      vaultId: typeof job.vaultId === "string" ? job.vaultId : null,
      title: typeof job.title === "string" ? job.title : "Untitled master track",
      styleLine: typeof job.styleLine === "string" ? job.styleLine : "",
      vocalProfile: typeof job.vocalProfile === "string" ? job.vocalProfile : "",
      startedAt: job.startedAt,
    };
  } catch {
    return null;
  }
}

/** True when a saved job has outlived the poll window and must be swept. */
function isStaleJob(job: PendingJob): boolean {
  return Date.now() - job.startedAt > POLL_TIMEOUT_MS;
}


/** Rendering status with a live elapsed clock so the wait never feels stuck. */
function renderingLabel(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, "0");
  return `Rendering production… ${mins}:${secs} elapsed (usually 3–5 minutes)`;
}

/**
 * What actually broke on the last run, so a retry only repeats that part:
 * - "render"  → nothing usable came back; the render has to start over.
 * - "poll"    → the engine is still working on the same task; just re-attach.
 * - "archive" → audio exists; only archiving/committing (and charging) failed.
 */
type RetryPlan =
  | { stage: "render"; label: string }
  | { stage: "poll"; label: string; job: PendingJob }
  | {
      stage: "archive";
      label: string;
      runId: string;
      vaultId: string | null;
      engineUrl: string;
      title: string;
      styleLine: string;
      vocalProfile: string;
    };


type HistoryStatus = "generating" | "ready" | "failed";

type HistoryItem = {
  id: string;
  title: string;
  audioUrl: string;
  at: number;
  status: HistoryStatus;
  prompt?: string;
  error?: string;
};

type Result = {
  title: string;
  style: string;
  vocalProfile: string;
  audioUrl: string;
  vocalUrl?: string | null;
  instrumentalUrl?: string | null;
  /** Raw Gate 1 engine audio, before stems and mastering. */
  rawAudioUrl?: string | null;
  taskId?: string | null;
};

/** Single source of truth for the generate run. */
type PipelineStepId =
  | "idle"
  | "validate"
  | "lyrics"
  | "composition"
  | "music" // legacy alias for composition (Gate 1)
  | "cwalo"
  | "stems"
  | "vocals"
  | "master"
  | "complete";

type PipelineStatus = "idle" | "loading" | "success" | "error";

type PipelineLastError = {
  step: string;
  message: string;
  raw: unknown;
};

type PipelineState = {
  currentStep: PipelineStepId;
  status: PipelineStatus;
  progress: number;
  lastError: PipelineLastError | null;
};

const IDLE_PIPELINE_STATE: PipelineState = {
  currentStep: "idle",
  status: "idle",
  progress: 0,
  lastError: null,
};

const PIPELINE_STEP_PROGRESS: Record<PipelineStepId, number> = {
  idle: 0,
  validate: 5,
  lyrics: PIPELINE_PROGRESS.lyrics,
  composition: PIPELINE_PROGRESS.sonic,
  music: PIPELINE_PROGRESS.sonic,
  cwalo: PIPELINE_PROGRESS.cwalo,
  stems: PIPELINE_PROGRESS.stems,
  vocals: PIPELINE_PROGRESS.vocals,
  master: PIPELINE_PROGRESS.master,
  complete: PIPELINE_PROGRESS.complete,
};

function previewPipelinePayload(value: unknown, max = 180): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "(empty)";
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value ?? "");
  }
}

function readErrorStep(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const step = (error as { step?: unknown }).step;
  if (typeof step === "string" && step.trim()) return step.trim();
  const landing = (error as { landing?: { failedGate?: unknown } }).landing;
  if (landing && typeof landing.failedGate === "string") {
    if (/gate\s*1/i.test(landing.failedGate)) return "composition";
  }
  return null;
}

function pipelineStepFromError(error: unknown, fallback: PipelineStepId): string {
  const fromPayload = readErrorStep(error);
  if (fromPayload) return fromPayload === "music" ? "composition" : fromPayload;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/GATE_1|composition|AIMusicAPI|Circuit Breaker.*Gate 1/i.test(message)) {
    return "composition";
  }
  if (/GATE_2|CWALO|structure analysis/i.test(message)) return "cwalo";
  if (/music engine|sonic|base audio/i.test(message)) return "composition";
  if (/GATE_3|stem|Demucs|demux/i.test(message)) return "stems";
  if (/vocal|Fish|Gate 5/i.test(message)) return "vocals";
  if (/GATE_4|GATE_5|master|Gate 6/i.test(message)) return "master";
  return fallback === "music" ? "composition" : fallback;
}

function displayPipelineStep(step: string | null | undefined, currentStep?: string): string {
  const value = (step || currentStep || "composition").trim();
  if (value === "music" || value === "sonic") return "composition";
  return value;
}

/** Normalises legacy rows (no id/status) so old history keeps rendering. */
function normalizeHistory(rows: unknown): HistoryItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row, index): HistoryItem => ({
      id: typeof row.id === "string" ? row.id : `legacy-${index}-${String(row.at ?? index)}`,
      title: typeof row.title === "string" ? row.title : "Untitled master track",
      audioUrl: typeof row.audioUrl === "string" ? row.audioUrl : "",
      at: typeof row.at === "number" ? row.at : Date.now(),
      status:
        row.status === "generating" || row.status === "failed" || row.status === "ready"
          ? (row.status as HistoryStatus)
          : typeof row.audioUrl === "string" && row.audioUrl
            ? "ready"
            : "failed",
      prompt: typeof row.prompt === "string" ? row.prompt : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
    }))

    // A "generating" row restored from storage is a run that never finished.
    .map((row) => (row.status === "generating" ? { ...row, status: "failed" as const, error: row.error ?? "Generation was interrupted." } : row))
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_MAX);
}

function readHistory(): HistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    return normalizeHistory(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

function saveHistory(rows: HistoryItem[]) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
  } catch {
    /* storage unavailable — history stays in memory */
  }
}

function readSavedLanguage(): LyricLanguage {
  if (typeof window === "undefined") return DEFAULT_LYRIC_LANGUAGE;
  try {
    const raw = window.localStorage.getItem(LANGUAGE_KEY);
    const value = raw ? JSON.parse(raw) : DEFAULT_LYRIC_LANGUAGE;
    return isValidLyricLanguage(value) ? value : DEFAULT_LYRIC_LANGUAGE;
  } catch {
    return DEFAULT_LYRIC_LANGUAGE;
  }
}

function readSavedCustomLanguage(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CUSTOM_LANGUAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLanguage(value: LyricLanguage) {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function saveCustomLanguage(value: string) {
  try {
    window.localStorage.setItem(CUSTOM_LANGUAGE_KEY, value);
  } catch {
    /* storage unavailable */
  }
}

/** Same-origin streaming URL used when a remote audio host blocks direct playback. */
export function proxiedAudioUrl(url: string, downloadName?: string): string {
  const base = `/api/public/audio-proxy?url=${encodeURIComponent(url)}`;
  return downloadName ? `${base}&download=${encodeURIComponent(downloadName)}` : base;
}

/** User-facing message shown whenever a stream drops or a source is unusable. */
const AUDIO_FAIL_MESSAGE = "Audio failed to load, please try again";

/** Shown when the engine returns no usable audio. */
const GENERATION_FAIL_MESSAGE = "Audio generation failed. Please try again.";
/** Sentinel for a user-cancelled render — never treated as an engine failure. */
const CANCELLED_MESSAGE = "Render canceled. No Hybrid Tokens were charged.";
/** Shown when a run left running before a refresh is swept away on load. */
const STALE_SWEPT_MESSAGE =
  "A stuck render from an earlier session was cleaned up. No Hybrid Tokens were charged.";

/**
 * True when the URL is something a browser can actually stream.
 * Guards the <audio> element from ever rendering a broken/unsafe source.
 */
export function isPlayableAudioSource(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url, typeof window === "undefined" ? "https://localhost" : window.location.origin);
    return ["https:", "blob:", "data:"].includes(parsed.protocol) || parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}


function safeFileName(title: string, extension: string): string {
  const base = (title || "hybrid-track").replace(/[^\w.\- ]+/g, "_").trim().slice(0, 80);
  return `${base || "hybrid-track"}.${extension}`;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "webm",
};

const KNOWN_EXTENSIONS = new Set(Object.values(MIME_EXTENSIONS));

/** Real file extension for the track, from the source URL or the response MIME type. */
function resolveExtension(url: string, contentType: string | null): string {
  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime]!;
  try {
    const path = new URL(url, window.location.origin).pathname.toLowerCase();
    const ext = path.split(".").pop() ?? "";
    if (KNOWN_EXTENSIONS.has(ext)) return ext;
  } catch {
    /* fall through */
  }
  return "mp3";
}

/** Fires an immediate browser download for a URL. */
function triggerAnchorDownload(href: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** What the proxy reports about an audio source, using the upstream headers. */
export type AudioProbe = { ok: boolean; status: string; gone: boolean; transient?: boolean };

/** Gateway/rate-limit hiccups worth retrying rather than surfacing to the user. */
const TRANSIENT_AUDIO_STATUS = new Set(["408", "425", "429", "500", "502", "503", "504", "network"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeAudioSourceOnce(url: string): Promise<AudioProbe> {
  try {
    const res = await fetch(proxiedAudioUrl(url), { headers: { Range: "bytes=0-1" } });
    if (res.ok || res.status === 206) return { ok: true, status: String(res.status), gone: false };
    const text = (await res.text().catch(() => "")).trim();
    const status =
      res.headers.get("x-upstream-status") ?? /\((\d{3})\)/.exec(text)?.[1] ?? String(res.status);
    const gone =
      ["0", "403", "404", "410"].includes(status) ||
      [403, 404, 410].includes(res.status) ||
      res.headers.get("x-proxy-reason") === "unreachable";
    return { ok: false, status, gone, transient: !gone && TRANSIENT_AUDIO_STATUS.has(status) };
  } catch {
    return { ok: false, status: "network", gone: false, transient: true };
  }
}

/**
 * Single source of truth for "can this audio be streamed right now?".
 * Both playback and downloads read the same upstream status headers. Transient
 * gateway failures (502/503/504…) are retried with exponential backoff so
 * playback recovers on its own.
 */
async function probeAudioSource(url: string, attempts = 4): Promise<AudioProbe> {
  let probe = await probeAudioSourceOnce(url);
  let delay = 400;
  for (let i = 1; i < attempts && !probe.ok && probe.transient; i += 1) {
    await sleep(delay);
    delay *= 2;
    probe = await probeAudioSourceOnce(url);
  }
  return probe;
}


/**
 * Shared regeneration flow: probe the source, and when it is unusable ask the
 * server to re-sign or re-archive it, then probe the replacement.
 */
async function resolveAudioSource(
  url: string,
): Promise<{ url: string; probe: AudioProbe; repaired: boolean }> {
  const probe = await probeAudioSource(url);
  if (probe.ok) return { url, probe, repaired: false };
  try {
    const result = await refreshTrackAudioUrl({ data: { audioUrl: url } });
    if (result.status === "ok" && result.audioUrl && result.audioUrl !== url) {
      return { url: result.audioUrl, probe: await probeAudioSource(result.audioUrl), repaired: true };
    }
  } catch {
    /* fall through to the original probe result */
  }
  return { url, probe, repaired: false };
}

/**
 * Downloads the exact generated file exactly once. The source is resolved (and
 * repaired if the link expired) first, then a single anchor click hands the
 * file off to the browser and the handler returns.
 */
const inFlightDownloads = new Set<string>();

async function downloadAudioFile(
  url: string,
  title: string,
  onUrlRepaired?: (oldUrl: string, newUrl: string) => void,
): Promise<void> {
  // Guard against double-clicks / re-render driven re-invocations.
  if (inFlightDownloads.has(url)) return;
  inFlightDownloads.add(url);

  try {
    let sourceUrl = url;
    const proxyUrl = proxiedAudioUrl(sourceUrl, safeFileName(title, "mp3"));
    let response: Response | null = null;
    try {
      response = await fetch(proxyUrl);
    } catch {
      response = null;
    }

    if (!response || !response.ok) {
      const resolved = await resolveAudioSource(sourceUrl);
      if (resolved.repaired) onUrlRepaired?.(sourceUrl, resolved.url);
      if (!resolved.probe.ok) {
        toast.error(
          resolved.probe.gone
            ? "This track's engine link has expired. Regenerate the track to download it."
            : `${AUDIO_FAIL_MESSAGE} (${resolved.probe.status}).`,
        );
        return;
      }
      sourceUrl = resolved.url;
      const retryUrl = proxiedAudioUrl(sourceUrl, safeFileName(title, "mp3"));
      try {
        response = await fetch(retryUrl);
      } catch {
        response = null;
      }
      if (!response || !response.ok) {
        // Last resort: a single direct hand-off to the browser.
        triggerAnchorDownload(retryUrl, safeFileName(title, "mp3"));
        return;
      }
    }

    const blob = await response.blob();
    const extension = resolveExtension(sourceUrl, response.headers.get("content-type") ?? blob.type);
    if (blob.size < 1024 || /^(text|application\/json)/.test(blob.type)) {
      toast.error(AUDIO_FAIL_MESSAGE);
      return;
    }
    const typedBlob = blob.type.startsWith("audio/")
      ? blob
      : new Blob([blob], { type: `audio/${extension}` });
    const objectUrl = URL.createObjectURL(typedBlob);
    triggerAnchorDownload(objectUrl, safeFileName(title, extension));
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  } finally {
    inFlightDownloads.delete(url);
  }
}






function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Lightweight synthetic waveform + scrubber driven by a single <audio> element. */
function WaveformPlayer({
  src,
  title,
  onUrlRepaired,
  onRegenerate,
  regenerating,
}: {
  src: string;
  title: string;
  onUrlRepaired?: (oldUrl: string, newUrl: string) => void;
  /** Re-renders the track with the current studio settings when the link is dead. */
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantPlayRef = useRef(false);
  const repairedRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  // Live URL for this track — swapped automatically when the original expires.
  const [activeSrc, setActiveSrc] = useState(src);
  // Never hand the <audio> element a source the browser cannot stream.
  const validSrc = useMemo(() => isPlayableAudioSource(activeSrc), [activeSrc]);
  // Same-origin proxy first (always CORS/hotlink safe), direct URL as fallback.
  const sources = useMemo(
    () => (validSrc ? [proxiedAudioUrl(activeSrc), activeSrc] : []),
    [activeSrc, validSrc],
  );
  const [sourceIndex, setSourceIndex] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Precise cause surfaced directly under the play button.
  type ErrorCause =
    | "autoplay-blocked"
    | "expired-link"
    | "proxy-http"
    | "invalid-source"
    | "network"
    | "unknown";
  const [errorCause, setErrorCause] = useState<ErrorCause | null>(null);
  // Exact HTTP status from the proxy when the cause is proxy/network related.
  const [errorStatus, setErrorStatus] = useState<string | null>(null);
  // True once we know the engine link is gone for good (403/404/410).
  const [expired, setExpired] = useState(false);

  // True when the browser refused autoplay — audio is fine, it just needs a tap.
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [repairing, setRepairing] = useState(false);


  const [bars] = useState(() =>
    Array.from({ length: 72 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 1.7)) * 0.75),
  );

  const progress = duration > 0 ? current / duration : 0;

  useEffect(() => {
    wantPlayRef.current = false;
    repairedRef.current = null;
    setActiveSrc(src);
    setSourceIndex(0);
    setLoadError(null);
    setErrorCause(null);
    setErrorStatus(null);
    setExpired(false);
    setAutoplayBlocked(false);

  }, [src]);


  useEffect(() => {
    if (validSrc) return;
    setLoadError(AUDIO_FAIL_MESSAGE);
    setErrorCause("invalid-source");
    setErrorStatus(null);
    toast.error(AUDIO_FAIL_MESSAGE);
  }, [validSrc]);







  /**
   * Uses the shared probe/repair flow (same upstream status headers as the
   * download path) to report a real reason and self-heal when possible.
   */
  const diagnose = useCallback(async () => {
    setRepairing(true);
    setErrorCause(null);
    setErrorStatus(null);
    try {
      const resolved = await resolveAudioSource(activeSrc);
      if (resolved.repaired && resolved.url !== activeSrc) {
        repairedRef.current = activeSrc;
        onUrlRepaired?.(activeSrc, resolved.url);
        setActiveSrc(resolved.url);
        setSourceIndex(0);
        setLoadError(null);
        setErrorCause(null);
        setErrorStatus(null);
        wantPlayRef.current = true;
        if (resolved.probe.ok) return;
      }
      if (resolved.probe.ok) {
        // The endpoint recovered (transient 502/503) — reload and resume
        // playback automatically instead of asking the user to retry.
        setLoadError(null);
        setErrorCause(null);
        setErrorStatus(null);
        wantPlayRef.current = true;
        const audio = audioRef.current;
        if (audio) {
          audio.load();
          void audio.play().catch(() => {
            setAutoplayBlocked(true);
            setErrorCause("autoplay-blocked");
            setErrorStatus(null);
            setLoadError(null);
          });

        }
        return;
      }

      if (resolved.probe.gone) {
        setExpired(true);
        setErrorCause("expired-link");
        setErrorStatus(resolved.probe.status);
        setLoadError(
          "This track's engine link has expired. Regenerate the track to restore playback.",
        );
        toast.error("This track's link expired — regenerate to restore playback.");
      } else {
        const cause: ErrorCause =
          resolved.probe.status === "network" ? "network" : "proxy-http";
        setErrorCause(cause);
        setErrorStatus(resolved.probe.status);
        setLoadError(`${AUDIO_FAIL_MESSAGE} (${resolved.probe.status}).`);
        toast.error(AUDIO_FAIL_MESSAGE);
      }
    } finally {
      setRepairing(false);
    }
  }, [activeSrc, onUrlRepaired]);





  const attemptPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!validSrc) {
      setLoadError(AUDIO_FAIL_MESSAGE);
      setErrorCause("invalid-source");
      setErrorStatus(null);
      toast.error(AUDIO_FAIL_MESSAGE);
      return;
    }
    wantPlayRef.current = true;
    setLoadError(null);
    setErrorCause(null);
    setErrorStatus(null);
    setAutoplayBlocked(false);
    try {
      audio.play().catch((error: unknown) => {
        // Autoplay policy rejection: the file is fine, the browser just needs a
        // direct tap. Surface the tap-to-play prompt instead of a source swap.
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          setAutoplayBlocked(true);
          setErrorCause("autoplay-blocked");
          setErrorStatus(null);
          return;
        }
        setSourceIndex((prev) => {
          if (prev + 1 < sources.length) return prev + 1;
          void diagnose();
          return prev;
        });
      });
    } catch {
      void diagnose();
    }
  }, [sources.length, diagnose, validSrc]);




  const seekTo = useCallback((ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
  }, []);


  return (
    <div className="space-y-3">
      <audio
        ref={audioRef}
        {...(sources[sourceIndex] ? { src: sources[sourceIndex] } : {})}
        preload="metadata"

        onError={() => {
          setErrorCause("proxy-http");
          setErrorStatus("checking");
          setSourceIndex((prev) => {
            if (prev + 1 < sources.length) return prev + 1;
            void diagnose();
            return prev;
          });
        }}

        onCanPlay={() => {
          setLoadError(null);
          setErrorCause(null);
          setErrorStatus(null);
          const audio = audioRef.current;
          if (wantPlayRef.current && audio?.paused) {
            void audio.play().catch(() => {
              setAutoplayBlocked(true);
              setErrorCause("autoplay-blocked");
              setErrorStatus(null);
            });
          }
        }}

        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => {
          setAutoplayBlocked(false);
          setErrorCause(null);
          setErrorStatus(null);
          setPlaying(true);
        }}


        onPause={() => setPlaying(false)}
        onEnded={() => {
          wantPlayRef.current = false;
          setPlaying(false);
        }}
      />


      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="icon"
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          onClick={() => {
            const audio = audioRef.current;
            if (!audio) return;
            if (audio.paused) attemptPlay();
            else {
              wantPlayRef.current = false;
              audio.pause();
            }
          }}
        >
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </Button>

        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          className="flex h-14 flex-1 cursor-pointer items-end gap-[2px] rounded-md bg-muted/20 px-2 py-2"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seekTo(progress + 0.05);
            if (e.key === "ArrowLeft") seekTo(progress - 0.05);
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seekTo((e.clientX - rect.left) / rect.width);
          }}
        >
          {bars.map((height, index) => {
            const played = index / bars.length <= progress;
            return (
              <span
                key={index}
                className={`flex-1 rounded-sm ${played ? "bg-primary" : "bg-muted-foreground/30"}`}
                style={{ height: `${height * 100}%` }}
              />
            );
          })}
        </div>

        <span className="w-20 text-right font-mono text-xs text-muted-foreground">
          {formatTime(current)} / {formatTime(duration)}
        </span>
      </div>

      {/* Precise playback error cause shown directly beneath the play button. */}
      {errorCause ? (
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
          <span className="inline-block size-2 rounded-full bg-destructive" aria-hidden />
          <p className="text-xs font-medium text-destructive">
            {errorCause === "autoplay-blocked" && "Autoplay blocked — tap the play button to start."}
            {errorCause === "expired-link" && "Audio link expired — use Regenerate Track to restore."}
            {errorCause === "proxy-http" && (
              errorStatus ? `Audio proxy returned HTTP ${errorStatus}.` : "Stream error from audio proxy — retrying or repair needed."
            )}
            {errorCause === "network" && "Network error — check your connection and try again."}
            {errorCause === "invalid-source" && "Audio source is invalid or missing."}
          </p>
        </div>
      ) : null}


      {repairing ? (

        <p className="text-xs text-muted-foreground">Renewing this track's link…</p>
      ) : autoplayBlocked ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs text-muted-foreground">
            Your browser blocked autoplay. The track is ready — tap play once to start it.
          </p>
          <Button type="button" size="sm" onClick={attemptPlay}>
            <Play className="size-4" aria-hidden />
            Tap to play
          </Button>
        </div>
      ) : loadError ? (

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{loadError}</p>
          {expired && onRegenerate ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={regenerating}
              onClick={onRegenerate}
            >
              {regenerating ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-4" aria-hidden />
              )}
              Regenerate Track
            </Button>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}
function InlineTip({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label ?? "More info"}
            className="inline-flex shrink-0 translate-y-px items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <HelpCircle className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[18rem] text-xs leading-snug">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The whole studio: one centered card that writes a prompt, picks a style,
 * spends a Hybrid Token, renders a mastered track through MiniMax 2.6 and
 * reveals the finished master right underneath.
 */
export function AudioStudio() {
  // iOS Safari can tear the page down mid-redirect (OAuth, token checkout) or
  // during an address-bar reflow. The session draft is restored *after* mount,
  // never during render: reading sessionStorage while rendering makes the first
  // client pass disagree with the server HTML, and that hydration mismatch is
  // exactly what paints a white screen on WebKit.
  const [lyrics, setLyrics] = useState("");
  const [vocalPrompt, setVocalPrompt] = useState("");

  const [lyricWarnings, setLyricWarnings] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [styles, setStyles] = useState<string[]>([]);
  /** Freeform descriptors sent to the engine verbatim, alongside any chips. */
  const [stylePrompt, setStylePrompt] = useState("");
  const [genreSearch, setGenreSearch] = useState("");
  const [vocalSearch, setVocalSearch] = useState("");
  const [vocalActiveIndex, setVocalActiveIndex] = useState(-1);
  const genrePopover = useReturnFocus<HTMLButtonElement>();
  const vocalPopover = useReturnFocus<HTMLButtonElement>();
  const vocalOpen = vocalPopover.open;
  const setVocalOpen = vocalPopover.setOpen;



  const [withVocals, setWithVocals] = useState(true);
  const [targetDuration, setTargetDuration] = useState<number>(DEFAULT_TARGET_DURATION_SECONDS);
  const [bpm, setBpm] = useState<number>(DEFAULT_BPM);
  const [audioInfluence, setAudioInfluence] = useState<number>(DEFAULT_INFLUENCE);
  const [weirdness, setWeirdness] = useState<number>(DEFAULT_WEIRDNESS);
  const [styleInfluence, setStyleInfluence] = useState<number>(DEFAULT_STYLE_INFLUENCE);
  const [studioStep, setStudioStep] = useState(0);
  useEffect(() => {
    if (studioStep > STUDIO_STEPS.length - 1) setStudioStep(STUDIO_STEPS.length - 1);
  }, [studioStep]);
  const engineControlsTouchedRef = useRef(false);
  const [engineControlsTouched, setEngineControlsTouched] = useState(false);



  const [vocalPresets, setVocalPresets] = useState<string[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [vocalSource, setVocalSource] = useState<VocalSourceMode>("default-ai");
  const [selectedVocalGender, setSelectedVocalGender] = useState<SelectedVocalGender>("");

  /** Restores the composer from the session draft on the first client commit. */
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    const draft = readEngineDraft({
      lyrics: "",
      title: "",
      styles: [],
      withVocals: true,
      targetDuration: DEFAULT_TARGET_DURATION_SECONDS,
      bpm: DEFAULT_BPM,
      audioInfluence: DEFAULT_INFLUENCE,
      weirdness: DEFAULT_WEIRDNESS,
      styleInfluence: DEFAULT_STYLE_INFLUENCE,
      vocalPresets: [],
      voiceId: "",
    });
    if (!draft) return;
    setLyrics(draft.lyrics);
    setTitle(draft.title);
    setStyles(draft.styles);
    setStylePrompt(draft.stylePrompt);
    setWithVocals(draft.withVocals);
    setTargetDuration(draft.targetDuration);
    setBpm(draft.bpm);
    setAudioInfluence(draft.audioInfluence);
    setWeirdness(draft.weirdness);
    setStyleInfluence(draft.styleInfluence);
    setVocalPresets(draft.vocalPresets);
    setVoiceId(draft.voiceId);
    if (draft.voiceId) setVocalSource("custom-upload");
    engineControlsTouchedRef.current = true;
    setEngineControlsTouched(true);
    if (draftHasContent(draft)) toast.success("Restored your last engine session.");
  }, []);


  // Read after mount, not in the initializer: a stored "yes" would otherwise
  // make the first client render disagree with the server HTML.
  const [vocalConsent, setVocalConsent] = useState(false);
  useEffect(() => {
    setVocalConsent(readStoredVocalConsent());
  }, []);

  const [customVocalFile, setCustomVocalFile] = useState<File | Blob | null>(null);
  /** Object URL for the current custom take — mirrors QuickVocalRecorder clip for playback / Fish. */
  const [vocalAudioUrl, setVocalAudioUrl] = useState<string | null>(null);
  const recordedVoiceBlob = customVocalFile;


  const [balance, setBalance] = useState<number | null>(
    isDevAuthBypass() ? DEV_TEST_TOKEN_BALANCE : null,
  );
  const [signedIn, setSignedIn] = useState(isDevAuthBypass());
  const [topUpOpen, setTopUpOpen] = useState(false);

  const [busy, setBusy] = useState(false);
  /** True while a render is in flight — blocks double submissions instantly. */
  const runningRef = useRef(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [rollbackNotice, setRollbackNotice] = useState<string | null>(null);
  const [retryPlan, setRetryPlan] = useState<RetryPlan | null>(null);
  /**
   * Platform render credits are a different meter from Hybrid Tokens: an
   * account can hold tokens while the engine itself cannot pay for a render.
   */
  const [creditsOut, setCreditsOut] = useState(false);
  const [creditCheckBusy, setCreditCheckBusy] = useState(false);

  // Cancel is hidden while a render runs; this flag is only for dropped jobs.
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [pipelineState, setPipelineState] = useState<PipelineState>(IDLE_PIPELINE_STATE);
  /** Server-authoritative gate bitmask — badges light only via hasPassedGate. */
  const [serverGateMask, setServerGateMask] = useState(PipelineGate.NONE);
  const pipelineStepRef = useRef<PipelineStepId>("idle");
  const [playbackKind, setPlaybackKind] = useState<StemKind>("mastered");
  const [playbackSrc, setPlaybackSrc] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [exportingUrl, setExportingUrl] = useState<string | null>(null);
  const exporting = exportingUrl !== null;
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const [aiBusy, setAiBusy] = useState<"concept" | "lyrics" | "vocal" | "style" | null>(null);
  const [isGeneratingLyrics, setIsGeneratingLyrics] = useState(false);
  const [language, setLanguage] = useState<LyricLanguage>(readSavedLanguage);
  const [customLanguage, setCustomLanguage] = useState(readSavedCustomLanguage);
  const trippedRef = useRef<Set<string>>(new Set());

  const fetchBalance = useServerFn(getTokenBalance);
  const spendToken = useServerFn(spendTokens);
  const reportGenerationFailure = useServerFn(notifyGenerationFailed);
  const runEngineHealthCheck = useServerFn(checkEngineHealth);
  const checkBreakerHealth = useServerFn(getEngineBreakerStatus);

  /**
   * Reads the platform render-credit meter. Runs once on load and on demand so
   * the artist is warned before starting a render instead of after it fails.
   */
  const refreshEngineCredits = useCallback(
    async (announce = false) => {
      setCreditCheckBusy(true);
      try {
        const health = (await runEngineHealthCheck({})) as {
          creditsExhausted?: boolean;
          reason?: string | null;
        };
        const out = Boolean(health?.creditsExhausted);
        setCreditsOut(out);
        if (announce) {
          if (out) toast.error(health?.reason || ENGINE_CREDIT_MESSAGE);
          else toast.success("Engine credits restored — you can generate again.");
        }
        return out;
      } catch {
        return false; // never block a render on a failed status probe
      } finally {
        setCreditCheckBusy(false);
      }
    },
    [runEngineHealthCheck],
  );

  useEffect(() => {
    if (!signedIn) return;
    void refreshEngineCredits();
  }, [signedIn, refreshEngineCredits]);



  const writeVocalPrompt = useServerFn(generateVocalPrompt);
  const openVaultTrack = useServerFn(createStudioTrack);
  const closeVaultTrack = useServerFn(finalizeStudioTrack);
  const loadVaultTracks = useServerFn(listStudioTracks);
  const openAudioVault = useServerFn(createUserVaultTrack);
  const closeAudioVault = useServerFn(finalizeUserVaultTrack);
  const [vaultTick, setVaultTick] = useState(0);
  /** Bumped when a render finishes so the vault catalog reloads. */
  const [generationCompleted, setGenerationCompleted] = useState(0);

  // Trigger a vault refresh when a track finishes
  useEffect(() => {
    if (!generationCompleted || !signedIn) return;
    void fetchUserVaultTracks().then(() => {
      setVaultTick((tick) => tick + 1);
    });
  }, [generationCompleted, signedIn]);



  const styleLine = styles.filter(Boolean).join(", ");
  /**
   * Freeform Style Prompt is the Gate 1 `tags` source of truth. Chips only
   * fill in when the textarea is empty — never rewrite or truncate typed text.
   */
  const styleTagsPreview = stylePrompt.trim() || styleLine;
  const targetLanguage = lyricLanguageInstruction(language, customLanguage);
  const trackTitle = title;
  const canProceed = Boolean(trackTitle?.trim() && lyrics?.trim());

  const applyPipelineProgress = useCallback(
    (stage: string, percent: number, gateMask?: number) => {
      reportPipelineProgress(stage, percent, undefined, gateMask);
      if (typeof gateMask === "number") {
        setServerGateMask(gateMask);
        // Never predict ahead of server bits — progress % from mask only.
        const maskPercent = percentFromGateMask(gateMask);
        const highest = PIPELINE_GATE_ORDER.reduce((acc, flag) => {
          return hasPassedGate(gateMask, flag) ? flag : acc;
        }, PipelineGate.NONE);
        const stepName = progressStageFromGateFlag(highest) || stage;
        const step = (
          stepName === "sonic" || stepName === "composition" || stepName === "vault" || stepName === "storage"
            ? "composition"
            : stepName === "cwalo" || stepName === "structure"
              ? "cwalo"
              : stepName === "stems" || stepName === "demux"
                ? "stems"
                : stepName === "vocals"
                  ? "vocals"
                  : stepName === "master" || stepName === "mastering"
                    ? "master"
                    : pipelineStepRef.current
        ) as PipelineStepId;
        pipelineStepRef.current = step;
        setPipelineState((prev) => ({
          ...prev,
          currentStep: step,
          status: gateMask === PIPELINE_COMPLETE ? "success" : "loading",
          progress: Math.max(maskPercent, percent > 0 && maskPercent === 0 ? 5 : maskPercent),
          lastError: gateMask === PIPELINE_COMPLETE ? null : prev.lastError,
        }));
        setStatusText(
          labelForProgressStage(
            step === "composition" || step === "music" ? "sonic" : step,
          ),
        );
        return;
      }
      // Without a server mask, only update label — do not advance gate badges.
      setStatusText(
        labelForProgressStage(
          stage === "music" || stage === "composition" ? "sonic" : stage,
        ),
      );
    },
    [],
  );

  const beginPipelineStep = useCallback((step: PipelineStepId, payloadPreview?: unknown) => {
    const normalized = step === "music" ? "composition" : step;
    pipelineStepRef.current = normalized;
    const progress = PIPELINE_STEP_PROGRESS[normalized];
    setPipelineState({
      currentStep: normalized,
      status: "loading",
      progress,
      lastError: null,
    });
    setStatusText(
      labelForProgressStage(normalized === "composition" ? "sonic" : normalized),
    );
    console.log(`[PIPELINE:STEP_START] ${normalized}`, {
      at: new Date().toISOString(),
      progress,
      payload: previewPipelinePayload(payloadPreview),
    });
  }, []);

  const completePipelineStep = useCallback((step: PipelineStepId, payloadPreview?: unknown) => {
    console.log(`[PIPELINE:STEP_DONE] ${step === "music" ? "composition" : step}`, {
      at: new Date().toISOString(),
      payload: previewPipelinePayload(payloadPreview),
    });
  }, []);

  const failPipelineStep = useCallback((step: string, error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error && "message" in error
          ? String((error as { message?: unknown }).message ?? "Pipeline execution failed")
          : String(error ?? "Pipeline execution failed");
    const resolvedStep = displayPipelineStep(
      step || readErrorStep(error),
      pipelineStepRef.current,
    );
    const lastError: PipelineLastError = { step: resolvedStep, message, raw: error };
    console.error(`[PIPELINE_ERROR] Step: ${resolvedStep} ->`, message, error);
    setPipelineState((prev) => ({
      ...prev,
      currentStep: (resolvedStep === "idle" ? "validate" : resolvedStep) as PipelineStepId,
      status: "error",
      lastError,
    }));
    setRollbackNotice(`${resolvedStep}: ${message}`);
    return lastError;
  }, []);

  function cancelGeneration() {
    cancelRef.current = true;
    abortRef.current?.abort();
  }

  const coproducerLock = useRef(false);

  async function handleCoProducerClick() {
    console.log("[DEBUG] Co-Producer button clicked directly");
    if (coproducerLock.current || isGeneratingLyrics) return;
    coproducerLock.current = true;
    setIsGeneratingLyrics(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
    try {
      console.log("[LYRIC_GEN] Starting request...");
      const res = await fetch("/api/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trackTitle: trackTitle || "Untitled Track",
          language: targetLanguage || language || "English",
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as { lyrics?: string; text?: string; error?: string };
      console.log("[LYRIC_GEN] Received response:", data);
      if (typeof data.lyrics === "string" && data.lyrics.trim()) {
        setLyrics(data.lyrics);
        setLyricWarnings([]);
      } else if (data?.error) {
        toast.error(String(data.error));
      } else {
        toast.error("Co-Producer returned no lyrics. Try again.");
      }
    } catch (err) {
      console.error("[FETCH_ERR]", err);
      const timedOut =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && /aborted|timed out/i.test(err.message));
      toast.error(timedOut ? "Lyric engine timed out" : err instanceof Error ? err.message : "Co-Producer request failed.");
    } finally {
      window.clearTimeout(timeoutId);
      coproducerLock.current = false;
      setIsGeneratingLyrics(false);
    }
  }

  /** Gemini fills the vocal prompt box from the lyrics, style and title. */
  async function handleWriteVocalPrompt() {
    if (aiBusy) return;
    const concept = lyrics.trim() || styleLine || title.trim();
    if (concept.length < 3) {
      toast.error("Add lyrics, a title or style first.");
      return;
    }
    if (!isValidLyricLanguage(language)) {
      toast.error("Invalid language selection.");
      setLanguage(DEFAULT_LYRIC_LANGUAGE);
      return;
    }
    setAiBusy("vocal");
    try {
      const out = await writeVocalPrompt({
        data: {
          concept: concept.slice(0, 600),
          lyrics: lyrics.trim() || undefined,
          style: styleLine || undefined,
          title: title.trim() || undefined,
          language: targetLanguage,
        },
      });
      setVocalPrompt(out.vocalPrompt.slice(0, 400));
      toast.success("Co-Producer wrote your vocal prompt.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The Co-Producer could not write a vocal prompt.");
    } finally {
      setAiBusy(null);
    }
  }

  /**
   * Gemini 2.5 Flash (Replicate) → genre-adaptive style tokens + lyric anchors.
   * Style tokens become Gate 1 `tags`; anchors inject into the lyrics box.
   */
  async function handleOptimizeStyle() {
    if (aiBusy) return;
    const userText = stylePrompt.trim() || styleLine;
    if (userText.length < 2) {
      toast.error("Type a style concept in the Style Prompt box first.");
      return;
    }
    setAiBusy("style");
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 70_000);
    try {
      const res = await fetch("/api/ai/optimize-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userText,
          bpm: clampBpm(bpm),
          lyrics,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        optimizedPrompt?: string;
        prompt?: string;
        lyricAnchors?: string[];
        lyrics?: string;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Style optimization failed.");
        return;
      }
      const next = (data.optimizedPrompt || data.prompt || "").trim();
      if (!next) {
        toast.error("Optimizer returned an empty prompt. Try again.");
        return;
      }
      setStylePrompt(next);
      if (typeof data.lyrics === "string" && data.lyrics.trim()) {
        setLyrics(data.lyrics);
      }
      const anchorCount = Array.isArray(data.lyricAnchors) ? data.lyricAnchors.length : 0;
      toast.success(
        anchorCount > 0
          ? `Style optimized with ${anchorCount} genre structure tags.`
          : "Style prompt optimized.",
      );
    } catch (err) {
      const timedOut =
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && /aborted|timed out/i.test(err.message));
      toast.error(
        timedOut
          ? "Style optimization timed out. Try again."
          : err instanceof Error
            ? err.message
            : "Style optimization failed.",
      );
    } finally {
      window.clearTimeout(timeoutId);
      setAiBusy(null);
    }
  }

  /** Language picker — selection writes `language` immediately and never submits the form. */
  function applyLanguage(value: string) {
    if (isValidLyricLanguage(value)) {
      setLanguage(value);
      return;
    }
    toast.error("Selected language is not supported.");
    setLanguage(DEFAULT_LYRIC_LANGUAGE);
  }

  function handleStep1Next() {
    if (!canProceed) {
      toast.error(STEP1_INCOMPLETE_MESSAGE);
      return;
    }
    setStudioStep(1);
  }

  function renderLanguagePicker(idPrefix: string) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${idPrefix}-language`} className="sr-only">
          Language
        </Label>
        <StudioLanguageSelect
          id={`${idPrefix}-language`}
          value={language}
          onChange={applyLanguage}
        />
      </div>
    );
  }


  // Local cache paints instantly; the cloud vault is the source of truth.
  useEffect(() => {
    setHistory(readHistory());
  }, []);

  // Persist lyric language preference across sessions.
  useEffect(() => {
    saveLanguage(language);
  }, [language]);

  /**
   * Circuit-breaker health is advisory only. The composer never asks anyone
   * to pick an engine — renders keep running in the background.
   */
  useEffect(() => {
    let cancelledCheck = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const run = async () => {
      try {
        const result = await checkBreakerHealth();
        if (cancelledCheck) return;
        for (const entry of result.engines) {
          const wasOpen = trippedRef.current.has(entry.engine);
          if (entry.open && !wasOpen) {
            trippedRef.current.add(entry.engine);
            toast.error("The music engine is cooling down", {
              description: "You can keep writing. No token is spent on a failed render.",
            });
          } else if (!entry.open && wasOpen) {
            trippedRef.current.delete(entry.engine);
            toast.success("The music engine is ready again.");
          }
        }
        const anyOpen = result.engines.some((e: EngineBreakerStatus) => e.open);
        timer = setTimeout(run, anyOpen ? 20_000 : 90_000);
      } catch {
        if (!cancelledCheck) timer = setTimeout(run, 120_000);
      }
    };

    void run();
    return () => {
      cancelledCheck = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkBreakerHealth]);


  useEffect(() => {
    saveCustomLanguage(customLanguage);
  }, [customLanguage]);

  // Session draft: keeps the composer alive across iOS Safari reloads and any
  // full-page redirect (Google sign-in, token checkout, gateway callbacks).
  const liveDraft = useMemo<EngineDraft>(
    () => ({
      lyrics,
      title,
      styles,
      stylePrompt,
      withVocals,
      targetDuration,
      bpm,
      audioInfluence,
      weirdness,
      styleInfluence,
      vocalPresets,
      voiceId,
    }),
    [
      lyrics,
      title,
      styles,
      stylePrompt,
      withVocals,
      targetDuration,
      bpm,
      audioInfluence,
      weirdness,
      styleInfluence,
      vocalPresets,
      voiceId,
    ],
  );

  const liveDraftRef = useRef(liveDraft);
  liveDraftRef.current = liveDraft;

  useEffect(() => {
    const id = window.setTimeout(() => writeEngineDraft(liveDraftRef.current), 400);
    return () => window.clearTimeout(id);
  }, [liveDraft]);

  // iOS Safari does not reliably fire `unload`; `pagehide` + `visibilitychange`
  // are the only hooks that survive a backgrounded tab being discarded.
  useEffect(() => {
    const flush = () => writeEngineDraft(liveDraftRef.current);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, []);

  // (The restore notice is raised by the draft-restore effect above.)




  /** Loads the signed-in artist's permanent track catalog from the database. */
  const loadLibrary = useCallback(async () => {
    try {
      const rows = await loadVaultTracks({ data: undefined });
      const items: HistoryItem[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        audioUrl: row.audioUrl,
        at: new Date(row.createdAt).getTime(),
        status: row.status,
        prompt: row.prompt || row.style || undefined,
        error: row.error ?? undefined,
      }));
      // The vault is the full catalogue — no display cap.
      setHistory(items);
      saveHistory(items.slice(0, HISTORY_MAX));
    } catch {
      /* offline or signed out — the local cache stays on screen */
    }
  }, [loadVaultTracks]);

  useEffect(() => {
    if (signedIn) void loadLibrary();
  }, [signedIn, loadLibrary]);


  const refreshBalance = useCallback(async () => {
    if (isDevAuthBypass()) {
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      return;
    }
    // Retry once: a single dropped request must not make the studio think the
    // artist is out of Hybrid Tokens.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await fetchBalance({ data: undefined });
        setBalance(result.balance);
        return;
      } catch {
        if (attempt === 0) await wait(1500);
      }
    }
  }, [fetchBalance]);


  useEffect(() => {
    if (isDevAuthBypass()) {
      setSignedIn(true);
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSignedIn(Boolean(data.session));
      if (data.session) void refreshBalance();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session));
      if (session) void refreshBalance();
      else setBalance(null);
    });
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<{ balance?: number }>).detail?.balance;
      if (typeof next === "number") setBalance(next);
      else void refreshBalance();
    };
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) void refreshBalance();
      });
    };
    const interval = window.setInterval(onFocus, 60000);
    window.addEventListener("hybrid:tokens-changed", onChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      sub.subscription.unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener("hybrid:tokens-changed", onChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshBalance]);


  function applyGenreEnginePreset(nextStyles: string[]) {
    if (engineControlsTouchedRef.current) return;
    const preset = presetForGenres(nextStyles);
    setBpm(preset.bpm);
    setAudioInfluence(preset.audioInfluence);
    setStyleInfluence(preset.styleInfluence);
    setWeirdness(preset.weirdness);
  }

  function markEngineControlsTouched() {
    engineControlsTouchedRef.current = true;
    setEngineControlsTouched(true);
  }

  function toggleStyle(tag: string) {
    setStyles((prev) => {
      const next = prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag];
      applyGenreEnginePreset(next);
      return next;
    });
  }

  const filteredGenreOptions = useMemo(() => {
    const q = genreSearch.trim().toLowerCase();
    if (!q) return GENRE_OPTIONS;
    return GENRE_OPTIONS.map((group) => ({
      ...group,
      genres: group.genres.filter((g) => g.toLowerCase().includes(q)),
    })).filter((group) => group.genres.length > 0);
  }, [genreSearch]);

  function toggleVocalPreset(tag: string) {
    setVocalPresets((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function activeVocalProfile(): string {
    return vocalProfileLabel({
      instrumental: !withVocals,
      vocalPresets: usesDefaultAiVocal(withVocals, vocalSource) ? vocalPresets : [],
    });
  }

  function resolvedVocalGender(): "m" | "f" | "Male" | "Female" | undefined {
    if (!withVocals) return undefined;
    if (selectedVocalGender === "m" || selectedVocalGender === "f") return selectedVocalGender;
    const genderPreset = vocalPresets.find((preset) =>
      GENDER_PRESETS.includes(preset as (typeof GENDER_PRESETS)[number]),
    );
    if (genderPreset === "Female Vocal") return "Female";
    if (genderPreset === "Male Vocal") return "Male";
    return undefined;
  }

  const filteredVocalOptions = useMemo(() => {
    const q = vocalSearch.trim().toLowerCase();
    if (!q) return VOCAL_STYLE_GROUPS;
    return VOCAL_STYLE_GROUPS.map((group) => ({
      ...group,
      options: group.options.filter((o) => o.toLowerCase().includes(q)),
    })).filter((group) => group.options.length > 0);
  }, [vocalSearch]);

  const vocalCustomEntry = useMemo(() => {
    const trimmed = vocalSearch.trim();
    if (!trimmed) return null;
    const exists =
      vocalPresets.some((p) => p.toLowerCase() === trimmed.toLowerCase()) ||
      VOCAL_STYLE_GROUPS.some((g) =>
        g.options.some((o) => o.toLowerCase() === trimmed.toLowerCase()),
      );
    return exists ? null : trimmed;
  }, [vocalSearch, vocalPresets]);

  /** Flat, in-DOM-order list of focusable vocal rows for arrow-key navigation. */
  const flatVocalRows = useMemo(() => {
    const rows = filteredVocalOptions.flatMap((g) => g.options);
    return vocalCustomEntry ? [...rows, vocalCustomEntry] : rows;
  }, [filteredVocalOptions, vocalCustomEntry]);

  useEffect(() => {
    setVocalActiveIndex(flatVocalRows.length ? 0 : -1);
  }, [flatVocalRows.length, vocalSearch]);

  const vocalActiveId =
    vocalActiveIndex >= 0 && flatVocalRows[vocalActiveIndex]
      ? `vocal-opt-${vocalActiveIndex}`
      : undefined;

  useEffect(() => {
    if (!vocalActiveId) return;
    document.getElementById(vocalActiveId)?.scrollIntoView({ block: "nearest" });
  }, [vocalActiveId]);



  function onVocalSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flatVocalRows.length) return;
      setVocalActiveIndex((prev) => {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const next = (prev + dir + flatVocalRows.length) % flatVocalRows.length;
        return next;
      });
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setVocalActiveIndex(flatVocalRows.length ? 0 : -1);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setVocalActiveIndex(flatVocalRows.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const active = vocalActiveIndex >= 0 ? flatVocalRows[vocalActiveIndex] : undefined;
      if (active && active !== vocalCustomEntry) {
        toggleVocalPreset(active);
        return;
      }
      addCustomVocalSound(vocalSearch);
    }
  }

  function addCustomVocalSound(sound: string) {
    const trimmed = sound.trim();
    if (!trimmed) return;
    setVocalPresets((prev) =>
      prev.some((p) => p.toLowerCase() === trimmed.toLowerCase()) ? prev : [...prev, trimmed],
    );
    setVocalSearch("");
  }


  /** Adds a run to the feed the moment it starts, newest first. */
  function pushHistory(item: HistoryItem) {
    setHistory((prev) => {
      const next = [item, ...prev.filter((entry) => entry.id !== item.id)]
        .sort((a, b) => b.at - a.at)
        .slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
  }

  /** Moves a pending run to its final state (ready or failed). */
  function updateHistory(id: string, patch: Partial<HistoryItem>) {
    setHistory((prev) => {
      const next = prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
      saveHistory(next);
      return next;
    });
  }

  /** Persists a renewed track URL everywhere it is referenced. */
  function applyRepairedUrl(oldUrl: string, newUrl: string) {
    setResult((prev) => (prev && prev.audioUrl === oldUrl ? { ...prev, audioUrl: newUrl } : prev));
    setHistory((prev) => {
      const next = prev.map((entry) =>
        entry.audioUrl === oldUrl ? { ...entry, audioUrl: newUrl } : entry,
      );
      saveHistory(next);
      return next;
    });
  }


  /** Direct, immediate download of the generated file. */
  function downloadTrack(url: string, title: string) {
    void downloadAudioFile(url, title, applyRepairedUrl);
  }

  async function handleShareResult() {
    if (!result) return;
    const trackId = result.taskId?.trim();
    const shareUrl = trackId
      ? `https://www.hybrid-ai-records.com/track/${trackId}`
      : "https://www.hybrid-ai-records.com/engine";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `${result.title} | Hybrid AI Records`,
          text: `Check out this track created on Hybrid AI Records: ${result.title}`,
          url: shareUrl,
        });
        return;
      } catch (err) {
        console.log("Share canceled or failed", err);
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(result.audioUrl || shareUrl);
      toast.success("Link copied to clipboard!");
    } catch {
      toast.message("Copy this link", { description: shareUrl });
    }
  }




  async function handleGenerate() {
    // Ref guard, not state: two clicks in the same tick both see the old
    // `busy` value, so only this synchronous flag can stop a double render.
    if (runningRef.current) return;
    setRollbackNotice(null);
    setRetryPlan(null);
    setPipelineState(IDLE_PIPELINE_STATE);
    pipelineStepRef.current = "idle";
    if (!signedIn) {
      toast.error("Sign in to generate a master track.");
      return;
    }
    if (!canProceed) {
      toast.error(STEP1_INCOMPLETE_MESSAGE);
      return;
    }
    if (!styleLine) {
      toast.error("Please select a core style or genre for the track.");
      return;
    }
    let studioPayload: ValidatedStudioPayload;
    try {
      studioPayload = getValidatedStudioPayload({
        style: styleLine,
        lyrics,
        videoPrompt: withVocals && vocalSource === "default-ai" ? vocalPrompt : "",
        withVocals,
        vocalMode: withVocals ? vocalSource : "default-ai",
        defaultVoiceId: "ai",
        termsAccepted: vocalConsent || readStoredVocalConsent(),
        customAudioFile: customVocalFile,
        customVoiceId: voiceId,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : STUDIO_CUSTOM_CONSENT_REQUIRED);
      return;
    }
    // A failed balance read leaves `balance` unknown (null). Never treat that
    // as "no tokens" — re-check with the server before blocking the render.
    if (!allowTokenlessGenerate() && balance !== null && balance < 1) {
      setTopUpOpen(true);
      return;
    }


    cancelRef.current = false;
    const abort = new AbortController();
    abortRef.current = abort;
    runningRef.current = true;
    setBusy(true);
    setResult(null);
    setPlaybackKind("mastered");
    setPlaybackSrc(null);
    setStatusText("Checking your Hybrid Tokens…");
    beginPipelineStep("validate", { style: styleLine, lyricsLength: lyrics.length });

    let runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const trackTitle = title.trim() || "Untitled master track";
    const promptSnippet = (title.trim() || lyrics.trim() || styleLine).slice(0, 160);
    // The run shows up in the feed immediately, so nothing is ever hidden.
    pushHistory({
      id: runId,
      title: trackTitle,
      audioUrl: "",
      at: Date.now(),
      status: "generating",
      prompt: promptSnippet,
    });
    notifyVaultOfNewGeneration({ title: trackTitle, style: styleLine || "Custom" });

    // Open the permanent vault record so the run survives refreshes and devices.
    let vaultId: string | null = null;
    try {
      const created = await openVaultTrack({
        data: { title: trackTitle, style: styleLine, prompt: promptSnippet },
      });
      vaultId = created.id;
      const localId = runId;
      runId = created.id;
      setHistory((prev) => {
        const next = prev.map((entry) => (entry.id === localId ? { ...entry, id: created.id } : entry));
        saveHistory(next);
        return next;
      });
    } catch {
      /* vault unavailable — the run still renders and stays in local history */
    }

    let audioVaultId: string | null = null;
    try {
      const opened = await openAudioVault({
        data: { title: trackTitle, style: styleLine },
      });
      audioVaultId = opened.id;
      notifyVaultOfNewGeneration({
        id: audioVaultId,
        title: trackTitle,
        style: styleLine || "Custom",
      });
      setVaultTick((tick) => tick + 1);
    } catch {
      /* user_vault migration may not be applied yet */
    }

    const recordAudioVault = async (patch: {
      status: "completed" | "failed";
      title?: string;
      masterUrl?: string;
      instrumentalUrl?: string | null;
      vocalUrl?: string | null;
    }) => {
      if (!audioVaultId) return;
      try {
        await closeAudioVault({
          data: {
            id: audioVaultId,
            status: patch.status,
            title: patch.title,
            masterUrl: patch.masterUrl,
            instrumentalUrl: patch.instrumentalUrl ?? undefined,
            vocalUrl: patch.vocalUrl ?? undefined,
          },
        });
        setVaultTick((tick) => tick + 1);
      } catch {
        /* keep the generator responsive if the vault write fails */
      }
    };

    /** Mirrors the run's final state into the database vault. */
    const recordVault = async (patch: {
      status: "ready" | "failed";
      audioUrl?: string;
      title?: string;
      error?: string;
    }) => {
      if (!vaultId) return null;
      try {
        return (await closeVaultTrack({ data: { id: vaultId, ...patch } })) as {
          ok: boolean;
          audioUrl?: string | null;
        };
      } catch {
        /* keep the UI responsive even if the vault write fails */
        return null;
      }
    };

    // Progress markers: they tell a later retry which stage actually failed.
    let stageTaskId: string | null = null;
    let stageStartedAt = Date.now();
    let stageAudio: string | null = null;
    let stageTitle = trackTitle;

    try {

      // Verify funds only — the balance is not touched until the track is
      // generated, archived to storage and committed to the vault.
      // A hiccup on this read must not cancel the render: the spend step at
      // the end is the real guard and it can never overdraw.
      let current: number | null = allowTokenlessGenerate() ? DEV_TEST_TOKEN_BALANCE : null;
      for (let attempt = 0; attempt < 2 && current === null; attempt += 1) {
        try {
          current = (await fetchBalance({ data: undefined })).balance;
        } catch {
          if (attempt === 0) await wait(1200);
        }
      }
      if (current !== null) setBalance(current);
      if (!allowTokenlessGenerate() && current !== null && current < 1) {
        setTopUpOpen(true);
        const message = "You need at least 1 Hybrid Token to generate a track.";
        failPipelineStep("validate", new Error(message));
        toast.error(message);
        updateHistory(runId, { status: "failed", error: message });
        await recordVault({ status: "failed", error: message });
        return;
      }


      // Second meter: platform render credits. If they were exhausted, confirm
      // before spending the artist's time on a render that cannot start.
      if (creditsOut && (await refreshEngineCredits())) {
        const message = ENGINE_CREDIT_MESSAGE;
        failPipelineStep("validate", new Error(message));
        setRetryPlan(null);
        toast.error(message);
        updateHistory(runId, { status: "failed", error: message });
        await recordVault({ status: "failed", error: message });
        return;
      }

      applyPipelineProgress("sonic", PIPELINE_PROGRESS.sonic);

      const selectedStyles = styles.filter(Boolean);
      // A freeform-only entry still needs a genre for the engine prompt.
      const genre = selectedStyles[0] || styleLine || stylePrompt.trim();
      const subGenre = selectedStyles.slice(1).join(", ");
      const vocalGender = resolvedVocalGender();
      const vocalStyle = vocalPresets
        .filter((preset) => !GENDER_PRESETS.includes(preset as (typeof GENDER_PRESETS)[number]))
        .filter(Boolean)
        .join(", ");
      const vocalProfile = usesDefaultAiVocal(withVocals, vocalSource)
        ? vocalPresets.filter(Boolean).join(", ")
        : "";
      const mood = vocalPrompt.trim();
      const arrangedLyrics = withVocals
        ? arrangeLyricsForDuration(formatLyricBlocks(lyrics), targetDuration)
        : "";
      // Textarea → tags verbatim. No genre-lock rebuild, no truncation.
      const styleTags = stylePrompt.trim() || selectedStyles.join(", ") || styleLine || genre;

      // Resolve custom vocal sample before the music step so an auth miss
      // never looks like a Sonic failure. Null session → local object URL only;
      // never abort the pipeline for guest / local-dev takes.
      let referenceAudioUrl: string | undefined;
      if (
        withVocals &&
        usesCustomVocal(studioPayload) &&
        voiceId &&
        isLocalVocalProfileId(voiceId) &&
        recordedVoiceBlob
      ) {
        const { data: auth } = await supabase.auth.getUser();
        const sessionUser = auth.user;
        console.log(
          "[VOICE_UPLOAD] Checking user session:",
          sessionUser ? sessionUser.id : "GUEST/LOCAL",
        );
        console.log("[VOICE_UPLOAD] Proceeding with audio blob size:", recordedVoiceBlob.size);

        const localPreviewUrl = URL.createObjectURL(recordedVoiceBlob);
        setVocalAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return localPreviewUrl;
        });
        console.log("[VOICE_UPLOAD] Local vocal preview ready:", localPreviewUrl.slice(0, 48));

        if (!sessionUser) {
          console.log(
            "[VOICE_UPLOAD] No session — skipping remote upload; advancing to music with local preview",
          );
        } else {
          console.log("[MIC_RECORD] Uploading recorded take for Fish / stem pipeline…", {
            bytes: recordedVoiceBlob.size,
            vocalAudioUrl: localPreviewUrl,
          });
          const file =
            recordedVoiceBlob instanceof File
              ? recordedVoiceBlob
              : new File([recordedVoiceBlob], `vocal-take-${Date.now()}.webm`, {
                  type: recordedVoiceBlob.type || "audio/webm",
                });
          try {
            const uploaded = await uploadVoiceSample(file);
            if (!uploaded.ok) {
              // Auth / guest soft-fail: keep local preview and continue to Sonic.
              if (/sign in/i.test(uploaded.message)) {
                console.warn("[VOICE_UPLOAD]", uploaded.message, "— continuing with local preview");
              } else {
                console.warn(
                  "[VOICE_UPLOAD] Upload failed — continuing with local preview:",
                  uploaded.message,
                );
              }
            } else if (/^https?:\/\//i.test(uploaded.url)) {
              referenceAudioUrl = uploaded.url;
            } else {
              console.log(
                "[VOICE_UPLOAD] Local object/data URL kept client-side; omitting from generate payload",
              );
              setVocalAudioUrl((prev) => {
                if (prev && prev !== uploaded.url) URL.revokeObjectURL(prev);
                return uploaded.url;
              });
            }
          } catch (uploadError) {
            console.warn(
              "[VOICE_UPLOAD] Upload threw — continuing with local preview:",
              uploadError instanceof Error ? uploadError.message : uploadError,
            );
          }
        }
      }

      // Linear handoff: lyrics → Sonic prompt; Style Prompt textarea → tags.
      beginPipelineStep("lyrics", { lyrics: arrangedLyrics || "(instrumental)" });
      completePipelineStep("lyrics", { chars: arrangedLyrics.length, withVocals });
      beginPipelineStep("composition", {
        prompt: arrangedLyrics || styleLine || genre,
        tags: styleTags,
        mv: "sonic-v5",
        custom_mode: true,
      });

      if (abort.signal.aborted) throw new Error(CANCELLED_MESSAGE);
      // Soft pulse only — never advance stage badges ahead of serverGateMask bits.
      setServerGateMask(PipelineGate.NONE);
      const stopTicker = window.setInterval(() => {
        setPipelineState((prev) => {
          if (prev.status !== "loading") return prev;
          return { ...prev, progress: Math.min(90, prev.progress + 1) };
        });
      }, 4000);
      let started: {
        taskId?: string;
        tracks?: Array<{ audioUrl: string | null; title: string | null }>;
        stems?: {
          masterUrl?: string | null;
          instrumentalUrl?: string | null;
          vocalUrl?: string | null;
          rawAudioUrl?: string | null;
        };
        gateMask?: number;
        landing?: { pipelineState?: number };
        tokenSettled?: boolean;
      };
      try {
        // MusicAPI credentials live only on the server (`AIMUSICAPI_KEY` /
        // `MUSICAPI_KEY` in `.env.local`). Never gate generate on
        // `import.meta.env.VITE_*` — SSE generate → `runGenerateEngineTrack`
        // reads `process.env` in the server. Keepalives prevent idle
        // "Failed to fetch" drops during Demucs / CWALO / Gate 1 waits.
        started = (await Promise.race([
          streamStudioGenerate({
            signal: abort.signal,
            onProgress: (event) => {
              if (!event || typeof event !== "object") return;
              const stage = typeof event.stage === "string" ? event.stage : "composition";
              const percent =
                typeof event.percent === "number" && Number.isFinite(event.percent)
                  ? event.percent
                  : 0;
              applyPipelineProgress(
                stage,
                percent,
                typeof event.pipelineState === "number" ? event.pipelineState : undefined,
              );
            },
            data: {
          prompt: arrangedLyrics || styleLine || genre,
          tags: styleTags,
          mv: "sonic-v5",
          style: genre,
          genre,
          ...(subGenre ? { subGenre } : {}),
          ...(mood ? { mood } : {}),
          instruments: [],
          ...(vocalProfile ? { vocalProfile } : {}),
          ...(withVocals && vocalGender ? { vocalGender } : {}),
          ...(withVocals && vocalStyle ? { vocalStyle } : {}),
          title: trackTitle,
          lyrics: arrangedLyrics,
          instrumental: !withVocals,
          // Native pronunciation, diacritics and accent are resolved from this
          // on the server and injected into the engine prompt.
          language,
          customLanguage: customLanguage.trim(),
          audioFormat: "mp3" as const,
          ...(withVocals && usesCustomVocal(studioPayload) && voiceId ? { voiceId } : {}),
          ...(referenceAudioUrl ? { referenceAudioUrl } : {}),
          termsAccepted:
            studioPayload.vocal_config.type === "custom"
              ? studioPayload.vocal_config.terms_accepted
              : true,
          customMode: true,

          model: "V4_5" as const,
          durationSeconds: Math.min(
            MINIMAX_MAX_SECONDS,
            Math.max(10, Math.round(targetDuration)),
          ),
          ...(audioVaultId ? { vaultId: audioVaultId } : {}),

          controls: {
            bpm: clampBpm(bpm),
            influence: clampInfluence(audioInfluence),
            weirdness: clampWeirdness(weirdness),
            styleInfluence: clampStyleInfluence(styleInfluence),
          },
        },
          }),
          abortableBarrier(abort.signal),
        ])) as typeof started;
      } finally {
        window.clearInterval(stopTicker);
      }
      if (abort.signal.aborted || cancelRef.current) throw new Error(CANCELLED_MESSAGE);
      const responseGateMask =
        started && typeof started === "object" && "gateMask" in started
          ? Number((started as { gateMask?: number }).gateMask ?? PipelineGate.NONE)
          : started && typeof started === "object" && "landing" in started
            ? Number(
                (started as { landing?: { pipelineState?: number } }).landing?.pipelineState ??
                  PipelineGate.NONE,
              )
            : PipelineGate.NONE;
      if (responseGateMask > 0) {
        applyPipelineProgress(
          "master",
          percentFromGateMask(responseGateMask),
          responseGateMask,
        );
      }
      completePipelineStep("composition", { taskId: started.taskId, tracks: started.tracks?.length ?? 0 });
      if (hasPassedGate(responseGateMask, PipelineGate.MASTERING)) {
        beginPipelineStep("master", { taskId: started.taskId });
      }

      const startedAt = Date.now();
      stageStartedAt = startedAt;
      stageTaskId = started.taskId ?? null;
      // Renders take several minutes. Remember the in-flight job so a refresh,
      // a locked phone or a tab switch can pick the same render back up
      // instead of stranding it and forcing the artist to start over.
      if (started.taskId) {
        savePendingJob({
          taskId: started.taskId,
          runId,
          vaultId,
          title: trackTitle,
          styleLine,
          vocalProfile: activeVocalProfile(),
          startedAt,
        });
      }


      // Widened to the poll response shape: start and poll return the same
      // tracks with different nullability, and both feed this variable.
      let ready: Array<{ audioUrl: string | null; title: string | null }> =
        (started.tracks ?? []).filter((t) => t.audioUrl);
      let pollErrors = 0;
      const deadline = startedAt + POLL_TIMEOUT_MS;
      while (ready.length === 0 && started.taskId && Date.now() < deadline) {
        if (cancelRef.current || abort.signal.aborted) throw new Error(CANCELLED_MESSAGE);
        setStatusText(renderingLabel(startedAt));
        await abortableDelay(POLL_INTERVAL_MS, abort.signal);
        if (cancelRef.current || abort.signal.aborted) throw new Error(CANCELLED_MESSAGE);
        try {
          const current = await checkStatus(started.taskId);
          pollErrors = 0;
          const audioReady = current.tracks.filter((t) => t.audioUrl);
          if (
            current.status === "completed" ||
            current.status === "succeeded" ||
            audioReady.length > 0
          ) {
            ready = audioReady;
            if (ready.length > 0) {
              setBusy(false);
              setRollbackNotice(null);
              runningRef.current = false;
            }
          }
        } catch (pollError) {
          // A dropped poll does not mean a dropped render: the engine keeps
          // working server-side, so we keep re-attaching for a few rounds and
          // tell the artist exactly what is happening.
          pollErrors += 1;
          if (pollErrors >= POLL_MAX_CONSECUTIVE_ERRORS) throw pollError;
          setStatusText(
            `Still rendering — reconnecting to the engine (attempt ${pollErrors} of ${POLL_MAX_CONSECUTIVE_ERRORS})…`,
          );
        }
      }
      if (ready.length === 0 && started.taskId) {
        throw new Error("The render is still going but timed out on this connection.");
      }
      if (cancelRef.current) throw new Error(CANCELLED_MESSAGE);



      const engineUrl = ready[0]?.audioUrl ?? "";
      // No audio, or something the browser can't stream: fail cleanly and let
      // the user try again instead of loading a broken player.
      if (!engineUrl || !isPlayableAudioSource(engineUrl)) {
        throw new Error(GENERATION_FAIL_MESSAGE);
      }

      const title = ready[0]?.title || trackTitle;
      stageAudio = engineUrl;
      stageTitle = title;

      // Persist first, then play from our own permanent storage URL only.
      const saved = await recordVault({ status: "ready", audioUrl: engineUrl, title });
      const audioUrl = saved?.audioUrl || engineUrl;
      if (!isPlayableAudioSource(audioUrl)) {
        throw new Error(GENERATION_FAIL_MESSAGE);
      }
      const stems =
        started && typeof started === "object" && "stems" in started
          ? (started.stems as {
              masterUrl?: string | null;
              instrumentalUrl?: string | null;
              vocalUrl?: string | null;
              rawAudioUrl?: string | null;
            })
          : null;
      await recordAudioVault({
        status: "completed",
        title,
        masterUrl: audioUrl,
        instrumentalUrl: stems?.instrumentalUrl,
        vocalUrl: stems?.vocalUrl,
      });

      // Everything landed: audio rendered, archived and committed. Charge now
      // only if the server did not already settle tokens in post-binary settlement.
      const serverTokenSettled =
        started && typeof started === "object" && "tokenSettled" in started
          ? Boolean((started as { tokenSettled?: boolean }).tokenSettled)
          : false;
      if (isDevAuthBypass()) {
        if (!serverTokenSettled) {
          setBalance((prev) => Math.max(0, (prev ?? DEV_TEST_TOKEN_BALANCE) - 1));
        }
      } else if (!serverTokenSettled) {
      const spend = await spendToken({
        data: { amount: 1, idempotencyKey: `gen:${runId}`, note: title },
      });
      if (spend.ok) {
        setBalance(spend.balance);
        window.dispatchEvent(
          new CustomEvent("hybrid:tokens-changed", { detail: { balance: spend.balance } }),
        );
      }
      } else if (serverTokenSettled) {
        // Refresh balance after server-side settlement.
        try {
          const bal = await fetchBalance({});
          if (bal && typeof bal.balance === "number") {
            setBalance(bal.balance);
            window.dispatchEvent(
              new CustomEvent("hybrid:tokens-changed", { detail: { balance: bal.balance } }),
            );
          }
        } catch {
          /* ignore */
        }
      }

      const finished: Result = {
        title,
        style: styleLine,
        vocalProfile: activeVocalProfile(),
        audioUrl,
        vocalUrl: stems?.vocalUrl,
        instrumentalUrl: stems?.instrumentalUrl,
        rawAudioUrl: stems?.rawAudioUrl,
        taskId: started.taskId,
      };
      applyPipelineProgress(
        "complete",
        PIPELINE_PROGRESS.complete,
        responseGateMask || PIPELINE_COMPLETE,
      );
      completePipelineStep("master", { audioUrl, stems: Boolean(stems) });
      setServerGateMask(responseGateMask || PIPELINE_COMPLETE);
      setPipelineState({
        currentStep: "complete",
        status: "success",
        progress: 100,
        lastError: null,
      });
      setResult(finished);
      setPlaybackKind("mastered");
      setPlaybackSrc(audioUrl);
      if (started.taskId) {
        void cacheStudioStemBlobs(started.taskId, {
          raw: audioUrl,
          mastered: audioUrl,
          vocal: stems?.vocalUrl,
          instrumental: stems?.instrumentalUrl,
        }).then((cached) => {
          if (!cached) return;
          void stemObjectUrl(started.taskId!, "mastered", audioUrl).then((url) => {
            if (url) setPlaybackSrc(url);
          });
        });
      }
      setBusy(false);
      setStatusText(null);
      notifyVaultOfNewGeneration({
        id: audioVaultId ?? undefined,
        title,
        style: styleLine || "Custom",
        status: "completed",
        masterUrl: audioUrl,
        instrumentalUrl: stems?.instrumentalUrl,
        vocalUrl: stems?.vocalUrl,
      });
      updateHistory(runId, { title, audioUrl, status: "ready", error: undefined });
      setGenerationCompleted((n) => n + 1);
      toast.success("Master track ready.");

    } catch (err) {
      setStatusText(null);
      const raw = err instanceof Error ? err.message : GENERATION_FAIL_MESSAGE;
      const message = readableEngineError(raw);
      const cancelled = message === CANCELLED_MESSAGE || isGenerationAborted(err);
      const failedStep = displayPipelineStep(
        pipelineStepFromError(err, pipelineStepRef.current),
        pipelineStepRef.current,
      );
      const abortMask =
        err && typeof err === "object" && "landing" in err
          ? Number(
              (err as { landing?: { pipelineState?: number } }).landing?.pipelineState ??
                serverGateMask,
            )
          : serverGateMask;
      if (typeof abortMask === "number" && abortMask > 0) {
        setServerGateMask(abortMask);
      }
      if (!cancelled) {
        failPipelineStep(failedStep, err);
      } else {
        setPipelineState((prev) => ({
          ...prev,
          status: "idle",
          lastError: null,
        }));
      }
      const recoveredAudio =
        !cancelled && stageAudio && isPlayableAudioSource(stageAudio) ? stageAudio : null;
      if (recoveredAudio) {
        const recoveredTitle = stageTitle || trackTitle;
        setResult({
          title: recoveredTitle,
          style: styleLine,
          vocalProfile: activeVocalProfile(),
          audioUrl: recoveredAudio,
        });
        setBusy(false);
        updateHistory(runId, { title: recoveredTitle, audioUrl: recoveredAudio, status: "ready" });
        await recordVault({ status: "ready", audioUrl: recoveredAudio, title: recoveredTitle });
        await recordAudioVault({
          status: "completed",
          title: recoveredTitle,
          masterUrl: recoveredAudio,
        });
        notifyVaultOfNewGeneration({
          id: audioVaultId ?? undefined,
          title: recoveredTitle,
          style: styleLine || "Custom",
          status: "completed",
          masterUrl: recoveredAudio,
        });
        setGenerationCompleted((n) => n + 1);
        toast.success("Master track ready.");
        return;
      }
      setResult(null);
      updateHistory(runId, { status: "failed", error: message });
      await recordVault({ status: "failed", error: message });
      await recordAudioVault({ status: "failed", title: trackTitle });
      // Engine credits, not the artist's tokens: no token was spent, and a
      // retry cannot help until the platform account is topped up.
      if (isEngineCreditsError(raw)) {
        setCreditsOut(true);
        setRetryPlan(null);
        setRollbackNotice(message);
        toast.error(message);
        setBusy(false);
        runningRef.current = false;
        return;
      }
      // Remember exactly which part failed so "Retry" only redoes that part.

      if (cancelled) {
        setRetryPlan({ stage: "render", label: "Start a new render" });
      } else if (stageAudio) {
        setRetryPlan({
          stage: "archive",
          label: "Retry saving this track (the audio already rendered — no re-render needed)",
          runId,
          vaultId,
          engineUrl: stageAudio,
          title: stageTitle,
          styleLine,
          vocalProfile: activeVocalProfile(),
        });
      } else if (stageTaskId && Date.now() - stageStartedAt < POLL_TIMEOUT_MS) {
        setRetryPlan({
          stage: "poll",
          label: "Retry — reconnect to the render already running",
          job: {
            taskId: stageTaskId,
            runId,
            vaultId,
            title: stageTitle,
            styleLine,
            vocalProfile: activeVocalProfile(),
            startedAt: stageStartedAt,
          },
        });
      } else {
        setRetryPlan({ stage: "render", label: "Retry generation" });
      }
      // Say exactly what went wrong (payload rejection vs server timeout vs
      // dropped connection) instead of one generic sentence.
      const explained = explainEngineFailure(raw);
      setRollbackNotice(cancelled ? CANCELLED_MESSAGE : explained.message);
      if (cancelled) toast.info(CANCELLED_MESSAGE);
      else toast.error(explained.headline, { description: explained.message });

      // Mirror the notice to the artist's inbox (in-app + email when set up).
      // A deliberate cancel isn't a failure, so it never raises an alert.
      if (signedIn && !cancelled) {
        try {
          await reportGenerationFailure({ data: { trackTitle: title || undefined, reference: runId } });
          refreshNotifications();
        } catch {
          /* notification is best-effort */
        }
      }



    } finally {
      clearPendingJob();
      if (abortRef.current === abort) abortRef.current = null;
      setBusy(false);
      runningRef.current = false;
    }
  }

  /**
   * Picks a render back up after a refresh, a phone lock or a dropped
   * connection: the engine keeps working server-side, so we just re-attach to
   * the same task instead of starting (and charging for) a brand new one.
   */
  const resumeRun = useCallback(
    async (job: PendingJob) => {
      if (runningRef.current) return;
      cancelRef.current = false;
      runningRef.current = true;
      setBusy(true);
      setRollbackNotice(null);
      setRetryPlan(null);
      let gotAudio: string | null = null;
      let gotTitle = job.title;
      setStatusText(renderingLabel(job.startedAt));
      try {
        let ready: { audioUrl?: string | null; title?: string | null }[] = [];
        let resumeErrors = 0;
        const deadline = job.startedAt + POLL_TIMEOUT_MS;
        while (ready.length === 0 && Date.now() < deadline) {
          if (cancelRef.current) throw new Error(CANCELLED_MESSAGE);
          setStatusText(renderingLabel(job.startedAt));
          try {
            const current = await checkStatus(job.taskId);
            resumeErrors = 0;
            const audioReady = current.tracks.filter((t) => t.audioUrl);
            if (
              current.status === "completed" ||
              current.status === "succeeded" ||
              audioReady.length > 0
            ) {
              ready = audioReady;
              if (ready.length > 0) {
                setBusy(false);
                setRollbackNotice(null);
                runningRef.current = false;
              }
            }
          } catch (pollError) {
            resumeErrors += 1;
            if (resumeErrors >= POLL_MAX_CONSECUTIVE_ERRORS) throw pollError;
            setStatusText(
              `Still rendering — reconnecting to the engine (attempt ${resumeErrors} of ${POLL_MAX_CONSECUTIVE_ERRORS})…`,
            );
          }
          if (ready.length > 0) break;
          await wait(POLL_INTERVAL_MS);
        }
        if (cancelRef.current) throw new Error(CANCELLED_MESSAGE);

        const engineUrl = ready[0]?.audioUrl ?? "";
        if (!engineUrl || !isPlayableAudioSource(engineUrl)) {
          throw new Error(GENERATION_FAIL_MESSAGE);
        }

        const finalTitle = ready[0]?.title || job.title;
        gotAudio = engineUrl;
        gotTitle = finalTitle;
        let audioUrl = engineUrl;
        if (job.vaultId) {
          const saved = (await closeVaultTrack({
            data: { id: job.vaultId, status: "ready", audioUrl: engineUrl, title: finalTitle },
          })) as { ok: boolean; audioUrl?: string | null };
          audioUrl = saved?.audioUrl || engineUrl;
        }

        if (isDevAuthBypass()) {
          setBalance((prev) => Math.max(0, (prev ?? DEV_TEST_TOKEN_BALANCE) - 1));
        } else {
        const spend = await spendToken({
          data: { amount: 1, idempotencyKey: `gen:${job.runId}`, note: finalTitle },
        });
        if (spend.ok) {
          setBalance(spend.balance);
          window.dispatchEvent(
            new CustomEvent("hybrid:tokens-changed", { detail: { balance: spend.balance } }),
          );
        }
        }

        setResult({
          title: finalTitle,
          style: job.styleLine,
          vocalProfile: job.vocalProfile,
          audioUrl,
        });
        setBusy(false);
        updateHistory(job.runId, {
          title: finalTitle,
          audioUrl,
          status: "ready",
          error: undefined,
        });
        setStatusText(null);
        notifyVaultOfNewGeneration({
          id: job.vaultId ?? undefined,
          title: finalTitle,
          style: job.styleLine || "Custom",
          status: "completed",
          masterUrl: audioUrl,
        });
        setGenerationCompleted((n) => n + 1);
        toast.success("Master track ready.");
      } catch (err) {
        setStatusText(null);
        const raw = err instanceof Error ? err.message : GENERATION_FAIL_MESSAGE;
        const message = readableEngineError(raw);
        const cancelled = message === CANCELLED_MESSAGE;
        if (isEngineCreditsError(raw)) setCreditsOut(true);

        if (gotAudio && !cancelled && isPlayableAudioSource(gotAudio)) {
          setResult({
            title: gotTitle,
            style: job.styleLine,
            vocalProfile: job.vocalProfile,
            audioUrl: gotAudio,
          });
          updateHistory(job.runId, {
            title: gotTitle,
            audioUrl: gotAudio,
            status: "ready",
            error: undefined,
          });
          if (job.vaultId) {
            try {
              await closeVaultTrack({
                data: { id: job.vaultId, status: "ready", audioUrl: gotAudio, title: gotTitle },
              });
            } catch {
              /* vault write is best-effort */
            }
          }
          notifyVaultOfNewGeneration({
            id: job.vaultId ?? undefined,
            title: gotTitle,
            style: job.styleLine || "Custom",
            status: "completed",
            masterUrl: gotAudio,
          });
          setGenerationCompleted((n) => n + 1);
          toast.success("Master track ready.");
          return;
        }

        updateHistory(job.runId, { status: "failed", error: message });

        if (job.vaultId) {
          try {
            await closeVaultTrack({ data: { id: job.vaultId, status: "failed", error: message } });
          } catch {
            /* vault write is best-effort */
          }
        }
        // Only the broken stage needs repeating on retry.
        if (cancelled) {
          setRetryPlan({ stage: "render", label: "Start a new render" });
        } else if (gotAudio) {
          setRetryPlan({
            stage: "archive",
            label: "Retry saving this track (the audio already rendered — no re-render needed)",
            runId: job.runId,
            vaultId: job.vaultId,
            engineUrl: gotAudio,
            title: gotTitle,
            styleLine: job.styleLine,
            vocalProfile: job.vocalProfile,
          });
        } else if (Date.now() - job.startedAt < POLL_TIMEOUT_MS) {
          setRetryPlan({
            stage: "poll",
            label: "Retry — reconnect to the render already running",
            job,
          });
        } else {
          setRetryPlan({ stage: "render", label: "Retry generation" });
        }
        const explainedResume = explainEngineFailure(raw);
        setRollbackNotice(cancelled ? CANCELLED_MESSAGE : explainedResume.message);
        if (cancelled) toast.info(CANCELLED_MESSAGE);
        else toast.error(explainedResume.headline, { description: explainedResume.message });
      } finally {
        clearPendingJob();
        setBusy(false);
        runningRef.current = false;
      }

    },
    [closeVaultTrack, spendToken],
  );

  /**
   * Retries only the part of the last run that failed:
   * a still-running render is re-attached to, an already-rendered track is
   * only re-archived and charged, and a truly dead run starts over. Tokens are
   * never charged twice because the charge is the final step in every path.
   */
  async function handleRetry() {
    const plan = retryPlan;
    if (!plan || busy || runningRef.current) return;
    setRollbackNotice(null);
    setRetryPlan(null);
    // Reset UI to Gate 1 composition before any retry path.
    pipelineStepRef.current = "composition";
    setServerGateMask(PipelineGate.NONE);
    setPipelineState({
      currentStep: "composition",
      status: "idle",
      progress: PIPELINE_STEP_PROGRESS.composition,
      lastError: null,
    });
    setStatusText(labelForProgressStage("sonic"));

    if (plan.stage === "render") {
      await handleGenerate();
      return;
    }

    if (plan.stage === "poll") {
      updateHistory(plan.job.runId, { status: "generating", error: undefined });
      await resumeRun(plan.job);
      return;
    }

    // "archive": the audio exists — repeat storage + vault commit + charge only.
    runningRef.current = true;
    setBusy(true);
    setStatusText("Saving your track…");
    try {
      let audioUrl = plan.engineUrl;
      if (plan.vaultId) {
        const saved = (await closeVaultTrack({
          data: { id: plan.vaultId, status: "ready", audioUrl: plan.engineUrl, title: plan.title },
        })) as { ok: boolean; audioUrl?: string | null };
        if (!saved?.audioUrl) throw new Error(GENERATION_FAIL_MESSAGE);
        audioUrl = saved.audioUrl;
      }

      if (isDevAuthBypass()) {
        setBalance((prev) => Math.max(0, (prev ?? DEV_TEST_TOKEN_BALANCE) - 1));
      } else {
      const spend = await spendToken({
        data: { amount: 1, idempotencyKey: `gen:${plan.runId}`, note: plan.title },
      });
      if (spend.ok) {
        setBalance(spend.balance);
        window.dispatchEvent(
          new CustomEvent("hybrid:tokens-changed", { detail: { balance: spend.balance } }),
        );
      }
      }

      setResult({
        title: plan.title,
        style: plan.styleLine,
        vocalProfile: plan.vocalProfile,
        audioUrl,
      });
      updateHistory(plan.runId, {
        title: plan.title,
        audioUrl,
        status: "ready",
        error: undefined,
      });
      setStatusText(null);
      toast.success("Master track ready.");
    } catch (err) {
      setStatusText(null);
      const message = err instanceof Error ? err.message : GENERATION_FAIL_MESSAGE;
      updateHistory(plan.runId, { status: "failed", error: message });
      setRetryPlan(plan);
      const explainedRetry = explainEngineFailure(message);
      setRollbackNotice(explainedRetry.message);
      toast.error(explainedRetry.headline, { description: explainedRetry.message });
    } finally {
      setBusy(false);
      runningRef.current = false;
    }
  }


  // On load: sweep away anything stuck from a previous session, otherwise
  // reattach to the render that is genuinely still in progress.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !signedIn) return;
    const job = readPendingJob(true);
    if (!job) return;
    resumedRef.current = true;

    if (isStaleJob(job)) {
      // Outlived the poll window — close it out so it can never hang the UI.
      clearPendingJob();
      updateHistory(job.runId, { status: "failed", error: STALE_SWEPT_MESSAGE });
      setRollbackNotice(STALE_SWEPT_MESSAGE);
      setRetryPlan({ stage: "render", label: "Retry generation" });
      if (job.vaultId) {
        void closeVaultTrack({
          data: { id: job.vaultId, status: "failed", error: STALE_SWEPT_MESSAGE },
        }).catch(() => {
          /* vault write is best-effort */
        });
      }
      toast.info(STALE_SWEPT_MESSAGE);
      return;
    }

    updateHistory(job.runId, { status: "generating", error: undefined });
    toast.info("Reconnecting to your track in progress…");
    void resumeRun(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, resumeRun]);

  // Resume polling immediately when the artist returns to this tab — browsers
  // throttle timers in the background, so a fresh status check on focus avoids
  // sitting on a delayed interval after the render may already be done.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const isGenerating = runningRef.current;
      if (!isGenerating) return;
      const pending = readPendingJob();
      const currentTaskId = pending?.taskId;
      if (!currentTaskId) return;
      void checkStatus(currentTaskId)
        .then((data) => {
          const audioUrl =
            data.tracks.find((t) => typeof t.audioUrl === "string" && t.audioUrl)?.audioUrl ?? null;
          const done =
            data.status === "completed" ||
            data.status === "succeeded" ||
            Boolean(audioUrl);
          if (!done || !audioUrl || !isPlayableAudioSource(audioUrl)) return;
          // Upstream finished while this tab was backgrounded — stop the spinner
          // and surface the track even if the delayed poll interval has not fired.
          setBusy(false);
          setRollbackNotice(null);
          setStatusText(null);
          runningRef.current = false;
          setResult({
            title: data.tracks[0]?.title || pending.title,
            style: pending.styleLine,
            vocalProfile: pending.vocalProfile,
            audioUrl,
            taskId: data.taskId || currentTaskId,
          });
          clearPendingJob();
          setGenerationCompleted((n) => n + 1);
        })
        .catch(() => {
          /* in-loop poll will retry */
        });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);




  /** Renders a mastered 16-bit 44.1 kHz WAV for any track in the studio. */
  async function exportWav(audioUrl: string, trackTitle: string) {
    if (exportingUrl) return; // one export at a time — no duplicate downloads
    setExportingUrl(audioUrl);
    try {
      let master;

      try {
        master = await masterWavFromUrl(audioUrl, { title: trackTitle });
      } catch {
        // Remote host may block direct fetches — retry through our own origin.
        master = await masterWavFromUrl(proxiedAudioUrl(audioUrl), { title: trackTitle });
      }
      const link = document.createElement("a");
      link.href = master.url;
      link.download = hybridMasterFileName(trackTitle);
      link.click();
      setTimeout(() => URL.revokeObjectURL(master.url), 30_000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "WAV export failed.");
    } finally {
      setExportingUrl(null);
    }
  }

  async function downloadWav(url?: string, label?: string) {
    if (!result) return;
    await exportWav(url ?? result.audioUrl, label ?? result.title);
  }

  function newTrack() {
    if (result?.taskId) revokeStemObjectUrls(result.taskId);
    setLyrics("");
    setVocalPrompt("");
    setTitle("");
    setResult(null);
    setPlaybackSrc(null);
    setPlaybackKind("mastered");
    setCustomVocalFile(null);
    setVocalAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setStatusText(null);
    setIsGeneratingLyrics(false);
    // Explicit reset wins over the restored session draft.
    clearEngineDraft();
  }

  const showAiVocalStyling = usesDefaultAiVocal(withVocals, vocalSource);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Card
        className="engine-wizard-card bg-zinc-900/80 backdrop-blur-md border border-zinc-800 shadow-2xl rounded-xl text-zinc-100 divide-y divide-zinc-800/50"
        style={{ position: "relative", zIndex: 50 }}
      >
        <CardContent className="space-y-5 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Hybrid Engine 1.0</h2>
            <div className="flex items-center gap-2">
              <NotificationBell signedIn={signedIn} />
              {signedIn ? (
                <>
                  <button
                    type="button"
                    onClick={() => setTopUpOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-semibold"
                  >
                    <HybridTokenIcon className="size-4 text-primary" />
                    {balance ?? "—"} Tokens
                  </button>
                  <button
                    type="button"
                    onClick={() => setTopUpOpen(true)}
                    className="text-xs font-medium text-primary underline"
                  >
                    Buy tokens
                  </button>
                </>
              ) : (
                <Link
                  to="/auth"
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-sm font-semibold"
                >
                  <HybridTokenIcon className="size-4 text-primary" />
                  Sign in
                </Link>
              )}
            </div>
          </div>

          <div
            id="studio-step-progress"
            className="relative z-0 space-y-2 border-b border-zinc-800 pb-3"
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <p className="font-semibold text-foreground">
                {busy
                  ? labelForProgressStage(
                      pipelineState?.currentStep === "music" ||
                      pipelineState?.currentStep === "composition"
                        ? "sonic"
                        : pipelineState?.currentStep ?? "composition",
                    )
                  : `Step ${studioStep + 1} of ${STUDIO_STEPS.length}: ${STUDIO_STEPS[studioStep]?.label ?? "Setup"}`}
              </p>
              <p className="tabular-nums text-muted-foreground">
                {busy
                  ? `${pipelineState?.progress ?? 0}%`
                  : `${studioStep + 1}/${STUDIO_STEPS.length}`}
              </p>
            </div>
            <Progress
              value={
                busy
                  ? pipelineState?.progress ?? 0
                  : ((studioStep + 1) / STUDIO_STEPS.length) * 100
              }
              className="pointer-events-none h-1.5"
              aria-label={
                busy
                  ? `Generation progress ${pipelineState?.progress ?? 0} percent, ${labelForProgressStage(
                      pipelineState?.currentStep === "music" ||
                      pipelineState?.currentStep === "composition"
                        ? "sonic"
                        : pipelineState?.currentStep ?? "composition",
                    )}`
                  : `Form progress, step ${studioStep + 1} of ${STUDIO_STEPS.length}`
              }
            />
            {busy ? (
              <div
                className="flex flex-wrap gap-1.5"
                role="list"
                aria-label="Pipeline gate status"
              >
                {PIPELINE_GATE_ORDER.map((flag) => {
                  const lit = hasPassedGate(serverGateMask, flag);
                  const name = getGateNameFromFlag(flag);
                  return (
                    <span
                      key={flag}
                      role="listitem"
                      title={name}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                        lit
                          ? "bg-primary/20 text-primary"
                          : "bg-muted text-muted-foreground/70"
                      }`}
                      aria-current={lit ? "step" : undefined}
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            ) : null}
            <div className="flex gap-1" role="tablist" aria-label="Generate steps">
              {STUDIO_STEPS.map((step, index) => (
                <button
                  key={step.id}
                  type="button"
                  role="tab"
                  aria-selected={index === studioStep}
                  aria-current={index === studioStep ? "step" : undefined}
                  onClick={() => {
                    if (studioStep === 0 && index > 0 && !canProceed) {
                      toast.error(STEP1_INCOMPLETE_MESSAGE);
                      return;
                    }
                    setStudioStep(index);
                  }}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    index <= studioStep ? "bg-primary" : "bg-muted"
                  }`}
                  title={`Step ${index + 1}: ${step.label}`}
                >
                  <span className="sr-only">
                    Step {index + 1}: {step.label}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="relative z-10 space-y-5 pointer-events-auto">
          {studioStep === 0 ? (
          <div className="relative z-10 space-y-5 overflow-visible pointer-events-auto">
          {/* 1. Track title */}
          <div className="space-y-2">
            <Label htmlFor="studio-title" className="text-base font-semibold text-foreground">
              Track Title
            </Label>
            <Input
              id="studio-title"
              name="title"
              value={title}
              maxLength={120}
              placeholder="Enter your track title"
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Track title"
              aria-describedby="studio-title-help"
              autoComplete="off"
              enterKeyHint="done"
              className="h-12 select-text pointer-events-auto border border-border bg-input text-foreground placeholder:text-muted-foreground placeholder-dim transition-colors hover:border-primary/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            <p id="studio-title-help" className="text-xs text-muted-foreground">
              Name your track — up to 120 characters. Used as the file name and display title.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="studio-language" className="text-base font-semibold text-foreground">
              Language
            </Label>
            <StudioLanguageSelect
              id="studio-language"
              value={language}
              onChange={applyLanguage}
            />
            <p className="text-xs text-muted-foreground">
              Sets lyric pronunciation for Co-Producer and generate. Defaults to English.
            </p>
          </div>

          {/* 2. Lyrics box — no fieldset / inert / aria-hidden ancestor. */}
          <div className="relative z-10 space-y-2 overflow-visible pointer-events-auto">
            <div className="relative mb-2 flex items-center justify-between gap-3 overflow-visible">
              <Label htmlFor={SONG_LYRICS_INPUT_ID} className="text-base font-semibold text-foreground">
                Lyrics
              </Label>
              <button
                type="button"
                id="coproducer-submit-btn"
                tabIndex={0}
                aria-label="Generate lyrics with Co-Producer"
                aria-busy={isGeneratingLyrics === true}
                disabled={isGeneratingLyrics === true}
                onMouseDown={() => console.log("Mouse down fired on Co-Producer")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void handleCoProducerClick();
                  }
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleCoProducerClick();
                }}
                className="rounded bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-60"
                style={{ pointerEvents: "auto", position: "relative", zIndex: 99999, cursor: "pointer" }}
              >
                {isGeneratingLyrics ? "Co-Producer Writing..." : "Co-Producer"}
              </button>
            </div>
            <Textarea
              id={SONG_LYRICS_INPUT_ID}
              name="lyrics"
              value={lyrics}
              rows={8}
              maxLength={PROMPT_MAX}
              placeholder="Enter your custom lyrics here…"
              onChange={(e) => {
                setLyrics(e.target.value);
                if (lyricWarnings.length > 0) setLyricWarnings([]);
              }}
              className="resize-y select-text pointer-events-auto border border-zinc-800 bg-zinc-950 font-mono text-sm text-foreground placeholder:text-muted-foreground placeholder-dim focus-visible:border-primary"
            />
            {lyricWarnings.length > 0 ? (
              <div
                role="status"
                className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="space-y-1">
                  <p className="font-medium">
                    Co-Producer returned malformed structure tags — cleaned automatically.
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {lyricWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                  <p>Review the lyrics below before generating.</p>
                </div>
              </div>
            ) : null}
            <p className="text-right text-xs text-muted-foreground">
              {lyrics.length.toLocaleString()} / {PROMPT_MAX.toLocaleString()} characters —
              use [Verse] / [Chorus] / [Bridge] tags to shape the structure.
            </p>
          </div>
          </div>
          ) : null}

          {/* Settings: one step at a time */}
          {studioStep === 2 && showAiVocalStyling ? (
          <section id="ai-vocal-prompt-panel" className="relative overflow-visible rounded-xl border border-zinc-800 bg-zinc-950 px-3 sm:px-4">
            <h3 className="py-3 text-base font-semibold text-foreground">
              Vocal prompt
            </h3>
            <div className="space-y-2 pb-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
                {renderLanguagePicker("vocal")}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={aiBusy !== null}
                  onClick={() => void handleWriteVocalPrompt()}
                >
                  {aiBusy === "vocal" ? (
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="mr-2 size-4" aria-hidden />
                  )}
                  Co-Produce
                </Button>
              </div>
            <Textarea
              id="studio-vocal-prompt"
              value={vocalPrompt}
              rows={3}
              maxLength={400}
              placeholder="describe the vocal and delivery, eg rasp, male baritone, half sung, half rap, half reverb."
              onChange={(e) => setVocalPrompt(e.target.value.slice(0, 400))}
              className="resize-y select-text pointer-events-auto border border-zinc-800 bg-zinc-950 text-base text-foreground placeholder:text-muted-foreground placeholder-dim focus-visible:border-primary"
            />
            <p className="text-xs text-muted-foreground">
              Shapes how the vocal is performed. Ignored on instrumental renders.
            </p>
            </div>
          </section>
          ) : null}

          {studioStep === 1 ? (
          <section className="relative overflow-visible rounded-xl border border-zinc-800 bg-zinc-950 px-3 sm:px-4">
            <h3 className="py-3 text-base font-semibold text-foreground">
              1. General Style
            </h3>
            <div className="space-y-4 pb-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-semibold text-foreground" htmlFor={CORE_STYLE_SELECT_ID}><span className="inline-flex items-center gap-1.5">Core style <InlineTip label="What Core style controls">Core style defines the main genre blend. The engine uses these tags plus the Style Influence slider to lock the sound.</InlineTip></span></Label>
                <span className="text-xs text-muted-foreground">
                  Pick at least one genre
                </span>
              </div>
              <select
                id={CORE_STYLE_SELECT_ID}
                className="sr-only"
                tabIndex={-1}
                value={styleLine}
                onChange={() => undefined}
                aria-hidden
              >
                <option value="">{styleLine ? "" : "Choose a style"}</option>
                {styleLine ? <option value={styleLine}>{styleLine}</option> : null}
              </select>
              <div className="flex flex-wrap gap-2">
                {STYLE_CHIPS.map((tag) => {
                  const active = styles.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleStyle(tag)}
                      className={`rounded-full border px-3.5 py-2 text-sm font-semibold transition-all ${
                        active
                          ? "border-primary bg-primary text-primary-foreground shadow-[0_0_18px_-4px_var(--primary)]"
                          : "border-border-strong bg-background text-foreground hover:border-primary hover:text-primary"
                      }`}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>

              {/* Full genre multi-select — combine as many genres as you like. */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground"><span className="inline-flex items-center gap-1">Browse more genres <InlineTip label="Browse more genres">Tick as many genres as you want — e.g. Rock + Cinematic — and the engine blends them into one request.</InlineTip></span></Label>
                <Popover open={genrePopover.open} onOpenChange={genrePopover.setOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      ref={genrePopover.triggerRef}
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={genrePopover.open}
                      className="w-full justify-between border border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900 hover:text-zinc-100"
                    >
                      <span className="truncate text-left">
                        {styles.length
                          ? `${styles.length} genre${styles.length === 1 ? "" : "s"} selected`
                          : "Choose genres to combine…"}
                      </span>
                      <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" aria-hidden />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    side="bottom"
                    sideOffset={6}
                    avoidCollisions={false}
                    {...genrePopover.contentProps}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") genrePopover.closeAndReturnFocus();
                    }}
                    className={ENGINE_DROPDOWN_CLASS}
                    style={{ backgroundColor: "#09090b" }}
                  >

                    <div className="relative mb-2">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input
                        type="search"
                        placeholder="Search genres (e.g. Pop, Country)…"
                        value={genreSearch}
                        onChange={(e) => setGenreSearch(e.target.value)}
                        autoFocus
                        className="border border-zinc-800 bg-zinc-900 pl-9 text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary"
                      />
                    </div>
                    <div className="engine-genre-scroll flex-1 overflow-y-auto bg-zinc-950">
                      {filteredGenreOptions.length === 0 ? (
                        <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                          No genres match “{genreSearch}”
                        </p>
                      ) : (
                        filteredGenreOptions.map((group) => (
                          <div key={group.group} className="mb-2 last:mb-0">
                            <p className="px-2 py-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                              {group.group}
                            </p>
                            {group.genres.map((genre) => {
                              const active = styles.includes(genre);
                              return (
                                <button
                                  key={genre}
                                  type="button"
                                  aria-pressed={active}
                                  onClick={() => toggleStyle(genre)}
                                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                                    active ? "bg-primary/10 text-primary" : "hover:bg-muted/40"
                                  }`}
                                >
                                  <span
                                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                      active ? "border-primary bg-primary text-primary-foreground" : "border-border-strong"
                                    }`}
                                    aria-hidden
                                  >
                                    {active ? <Check className="size-3" /> : null}
                                  </span>
                                  {genre}
                                </button>
                              );
                            })}
                          </div>
                        ))
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => genrePopover.closeAndReturnFocus()}
                      className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-800"
                    >
                      Done
                    </button>
                  </PopoverContent>
                </Popover>
              </div>

              {styles.length ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {styles.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleStyle(tag)}
                        aria-label={`Remove ${tag}`}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/60 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
                      >
                        {tag}
                        <X className="size-3" aria-hidden />
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setStyles([])}
                      className="rounded-full border border-border-strong px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
                    >
                      Clear all
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Blending: <span className="text-foreground">{styleLine}</span>
                  </p>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="style-prompt" className="text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    Style Prompt / Genre Descriptors
                    <InlineTip label="Style Prompt / Genre Descriptors">
                      Sent unchanged as Gate 1 <code>tags</code>. Genre chips are only used when
                      this box is empty — nothing rewrites or truncates your text.
                    </InlineTip>
                  </span>
                </Label>
                <Textarea
                  id="style-prompt"
                  value={stylePrompt}
                  onChange={(event) => setStylePrompt(event.target.value)}
                  rows={4}
                  placeholder="Alternative Rock, grunge revival, 101 BPM, raw dynamic mood, overdriven electric guitar leads carry the hook while heavy live punchy drums and distorted bass fill the space"
                  className="resize-y select-text pointer-events-auto border border-zinc-800 bg-zinc-950 text-sm text-zinc-100 placeholder:text-muted-foreground placeholder-dim shadow-none focus-visible:border-primary focus-visible:ring-primary"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={aiBusy !== null}
                  onClick={() => void handleOptimizeStyle()}
                  className="w-full justify-center gap-2 border-zinc-800 bg-zinc-950 text-zinc-100 hover:bg-zinc-900 hover:text-zinc-100"
                >
                  {aiBusy === "style" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      Optimizing…
                    </>
                  ) : (
                    <>⚡ Optimize Style</>
                  )}
                </Button>
                {styleTagsPreview ? (
                  <p className="text-xs text-muted-foreground">
                    Engine tags: <span className="text-foreground">{styleTagsPreview}</span>
                  </p>
                ) : null}
              </div>

            </div>


            <div className="space-y-3 rounded-lg border border-border bg-muted/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="target-duration"><span className="inline-flex items-center gap-1.5">Song Length <InlineTip label="Song length">Total duration of the finished track. Longer tracks cost 1 token but take more time to generate.</InlineTip></span></Label>
                <span className="inline-flex items-center rounded-full border border-border-strong bg-muted/40 px-3 py-1 text-sm font-semibold tabular-nums text-foreground">
                  {formatDuration(targetDuration)} min
                </span>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Decrease target duration by 15 seconds"
                  disabled={targetDuration <= MIN_TARGET_DURATION_SECONDS}
                  onClick={() => setTargetDuration((s) => snapTargetDuration(s - TARGET_DURATION_STEP_SECONDS))}
                  className="shrink-0 rounded-md border border-border bg-background/60 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-40"
                >
                  − 15s
                </button>

                <input
                  id="target-duration"
                  type="range"
                  min={MIN_TARGET_DURATION_SECONDS}
                  max={MAX_TARGET_DURATION_SECONDS}
                  step={TARGET_DURATION_STEP_SECONDS}
                  value={targetDuration}
                  onChange={(e) => setTargetDuration(snapTargetDuration(Number(e.target.value)))}
                  className="fx-slider flex-1"
                  style={sliderFill(
                    targetDuration,
                    MIN_TARGET_DURATION_SECONDS,
                    MAX_TARGET_DURATION_SECONDS,
                  )}
                  aria-valuemin={MIN_TARGET_DURATION_SECONDS}
                  aria-valuemax={MAX_TARGET_DURATION_SECONDS}
                  aria-valuenow={targetDuration}
                  aria-label="Target duration in seconds"
                />

                <button
                  type="button"
                  aria-label="Increase target duration by 15 seconds"
                  disabled={targetDuration >= MAX_TARGET_DURATION_SECONDS}
                  onClick={() => setTargetDuration((s) => snapTargetDuration(s + TARGET_DURATION_STEP_SECONDS))}
                  className="shrink-0 rounded-md border border-border bg-background/60 px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-40"
                >
                  + 15s
                </button>
              </div>

              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatDuration(MIN_TARGET_DURATION_SECONDS)}</span>
                <span>{formatDuration(MAX_TARGET_DURATION_SECONDS)}</span>
              </div>
            </div>
            </div>
          </section>
          ) : null}

          {studioStep === 3 ? (
          <section className="relative overflow-visible rounded-xl border border-zinc-800 bg-zinc-950 px-3 sm:px-4">
            <h3 className="py-3 text-base font-semibold text-foreground">
              Advanced
            </h3>
            <div className="pb-4">
            {!engineControlsTouched && styles.length ? (
              <p className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
                Loaded {styles[styles.length - 1]} defaults ({bpm} BPM, {styleInfluence}% style lock).
                Tweak only if you want a different feel.
              </p>
            ) : (
              <p className="mb-4 text-xs text-muted-foreground">
                Optional. Genre presets are already applied — generate as-is or fine-tune.
              </p>
            )}
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="engine-bpm"><span className="inline-flex items-center gap-1.5">BPM / Tempo <InlineTip label="Tempo">Target tempo in beats per minute. The engine matches this when possible.</InlineTip></span></Label>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label="Decrease tempo"
                      className="grid size-8 place-items-center rounded-md border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80"
                      onClick={() => {
                        markEngineControlsTouched();
                        setBpm((v) => clampBpm(v - 1));
                      }}
                    >
                      <Minus className="size-3.5" aria-hidden />
                    </button>
                    <Input
                      id="engine-bpm"
                      type="number"
                      min={MIN_BPM}
                      max={MAX_BPM}
                      value={bpm}
                      onChange={(e) => {
                        markEngineControlsTouched();
                        setBpm(clampBpm(Number(e.target.value)));
                      }}
                      onBlur={() => setBpm((v) => clampBpm(v))}
                      className="h-8 w-16 border-border bg-secondary text-center tabular-nums text-secondary-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      aria-label="Tempo in beats per minute"
                      aria-invalid={bpm < MIN_BPM || bpm > MAX_BPM}
                    />
                    <button
                      type="button"
                      aria-label="Increase tempo"
                      className="grid size-8 place-items-center rounded-md border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80"
                      onClick={() => {
                        markEngineControlsTouched();
                        setBpm((v) => clampBpm(v + 1));
                      }}
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </button>
                    <span className="text-xs text-muted-foreground">BPM</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  step={1}
                  value={bpm}
                  onChange={(e) => {
                    markEngineControlsTouched();
                    setBpm(clampBpm(Number(e.target.value)));
                  }}
                  className="fx-slider"
                  style={sliderFill(bpm, MIN_BPM, MAX_BPM)}
                  aria-label="Tempo slider"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{MIN_BPM} BPM</span>
                  <span>{MAX_BPM} BPM</span>
                </div>
                {(bpm < MIN_BPM || bpm > MAX_BPM) && (
                  <p className="text-xs text-destructive" role="alert">
                    Tempo must be between {MIN_BPM} and {MAX_BPM} BPM.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="engine-influence"><span className="inline-flex items-center gap-1.5">Audio Influence <InlineTip label="Audio influence">How much the engine should follow your uploaded voice or reference audio sample.</InlineTip></span></Label>
                  <span className="inline-flex items-center rounded-full border border-border-strong bg-muted/40 px-3 py-1 text-sm font-semibold tabular-nums text-foreground">
                    {audioInfluence}%
                  </span>
                </div>
                <input
                  id="engine-influence"
                  type="range"
                  min={MIN_INFLUENCE}
                  max={MAX_INFLUENCE}
                  step={5}
                  value={audioInfluence}
                  onChange={(e) => {
                    markEngineControlsTouched();
                    setAudioInfluence(clampInfluence(Number(e.target.value)));
                  }}
                  className="fx-slider"
                  style={sliderFill(audioInfluence, MIN_INFLUENCE, MAX_INFLUENCE)}
                  aria-label="Audio influence"
                  aria-invalid={audioInfluence < MIN_INFLUENCE || audioInfluence > MAX_INFLUENCE}
                />
                {(audioInfluence < MIN_INFLUENCE || audioInfluence > MAX_INFLUENCE) && (
                  <p className="text-xs text-destructive" role="alert">
                    Audio influence must be between {MIN_INFLUENCE}% and {MAX_INFLUENCE}%.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  How strictly the engine follows your reference style and prompt.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="engine-style-influence"><span className="inline-flex items-center gap-1.5">Style Influence <InlineTip label="Style influence">How strictly the engine locks onto the selected genres. Higher = less genre blending.</InlineTip></span></Label>
                  <span className="inline-flex items-center rounded-full border border-border-strong bg-muted/40 px-3 py-1 text-sm font-semibold tabular-nums text-foreground">
                    {styleInfluence}%
                  </span>
                </div>
                <input
                  id="engine-style-influence"
                  type="range"
                  min={MIN_STYLE_INFLUENCE}
                  max={MAX_STYLE_INFLUENCE}
                  step={5}
                  value={styleInfluence}
                  onChange={(e) => {
                    markEngineControlsTouched();
                    setStyleInfluence(clampStyleInfluence(Number(e.target.value)));
                  }}
                  className="fx-slider"
                  style={sliderFill(styleInfluence, MIN_STYLE_INFLUENCE, MAX_STYLE_INFLUENCE)}
                  aria-label="Style influence"
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Loose</span>
                  <span>Genre locked</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {styleInfluenceLabel(styleInfluence)} — how hard the engine weights your selected
                  genre and style tags.
                </p>
              </div>



              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="engine-weirdness"><span className="inline-flex items-center gap-1.5">Weirdness <InlineTip label="Weirdness">How experimental or unexpected the production can be. Low = safe; high = creative sound design.</InlineTip></span></Label>
                  <span className="inline-flex items-center rounded-full border border-border-strong bg-muted/40 px-3 py-1 text-sm font-semibold tabular-nums text-foreground">
                    {weirdness}%
                  </span>
                </div>
                <input
                  id="engine-weirdness"
                  type="range"
                  min={MIN_WEIRDNESS}
                  max={MAX_WEIRDNESS}
                  step={5}
                  value={weirdness}
                  onChange={(e) => {
                    markEngineControlsTouched();
                    setWeirdness(clampWeirdness(Number(e.target.value)));
                  }}
                  className="fx-slider"
                  style={sliderFill(weirdness, MIN_WEIRDNESS, MAX_WEIRDNESS)}
                  aria-label="Weirdness"
                  aria-invalid={weirdness < MIN_WEIRDNESS || weirdness > MAX_WEIRDNESS}
                />
                {(weirdness < MIN_WEIRDNESS || weirdness > MAX_WEIRDNESS) && (
                  <p className="text-xs text-destructive" role="alert">
                    Weirdness must be between {MIN_WEIRDNESS}% and {MAX_WEIRDNESS}%.
                  </p>
                )}
              <p className="text-xs text-muted-foreground">
                Temperature {weirdnessToTemperature(weirdness).toFixed(2)}
                {weirdness >= 60 ? " — experimental sound design tags enabled." : ""}
              </p>
            </div>
            </div>
            </div>
          </section>
          ) : null}

          {studioStep === 2 ? (
          <section className="relative overflow-visible rounded-xl border border-zinc-800 bg-zinc-950 px-3 sm:px-4">
            <h3 className="py-3 text-base font-semibold text-foreground">
              Vocals
            </h3>
            <div className="space-y-4 pb-4">
          <div className="space-y-2">
            <Label className="text-sm font-semibold text-foreground"><span className="inline-flex items-center gap-1.5">Lead <InlineTip label="Vocals">Choose whether the final track has lead vocals or is instrumental.</InlineTip></span></Label>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { label: "Full Track with Vocals", value: true },
                  { label: "Instrumental Only", value: false },
                ].map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={withVocals === option.value}
                    onClick={() => setWithVocals(option.value)}
                    className={`rounded-md border-2 px-3 py-2.5 text-sm font-semibold transition-colors ${
                      withVocals === option.value
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border-strong bg-background text-foreground hover:border-primary/60"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {withVocals ? (
              <>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-semibold text-foreground">Vocal source</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(
                      [
                        { value: "default-ai" as const, label: "Default AI Vocal" },
                        { value: "custom-upload" as const, label: "Custom Upload" },
                      ]
                    ).map((option) => {
                      const selected = vocalSource === option.value;
                      return (
                        <label
                          key={option.value}
                          className={`flex cursor-pointer items-center gap-2 rounded-md border-2 px-3 py-2.5 text-sm font-semibold transition-colors ${
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border-strong bg-background text-foreground hover:border-primary/60"
                          }`}
                        >
                          <input
                            type="radio"
                            name={VOCAL_SOURCE_NAME}
                            value={option.value}
                            checked={selected}
                            onChange={() => {
                              setVocalSource(option.value);
                              if (option.value === "default-ai") setVoiceId("");
                              if (option.value === "custom-upload") setVocalOpen(false);
                            }}
                            className="accent-primary"
                          />
                          {option.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                {vocalSource === "custom-upload" ? (
                  <p className="text-xs text-muted-foreground">
                    Your custom take is the lead vocal. AI voice tags stay off until you switch back
                    to Default AI Vocal.
                  </p>
                ) : null}

                {showAiVocalStyling ? (
                <div id={AI_VOCAL_STYLING_ID} className="space-y-4">
                {/* Explicit male / female choice */}
                <div className="space-y-2">
                  <Label className="text-sm font-semibold text-foreground"><span className="inline-flex items-center gap-1.5">Voice <InlineTip label="Voice gender">Pick a base gender for the lead vocal. You can still layer vocal sounds below.</InlineTip></span></Label>
                  <div className="grid grid-cols-2 gap-3">
                    {GENDER_PRESETS.map((preset) => {
                      const active = vocalPresets.includes(preset);
                      return (
                        <button
                          key={preset}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            setVocalPresets((prev) => {
                              const without = prev.filter(
                                (p) => !GENDER_PRESETS.includes(p as (typeof GENDER_PRESETS)[number]),
                              );
                              return active ? without : [...without, preset];
                            })
                          }
                          className={`rounded-lg border-2 px-4 py-3.5 text-base font-semibold transition-all ${
                            active
                              ? "border-primary bg-primary text-primary-foreground shadow-[0_0_22px_-6px_var(--primary)]"
                              : "border-border-strong bg-background text-foreground hover:border-primary hover:text-primary"
                          }`}
                        >
                          {preset.replace(" Vocal", "")}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* One combined vocal sound picker with search + custom typing */}
                <div id={VOCAL_SOUND_CONTROLS_ID} className="space-y-2">
                  <Label id="vocal-sound-label" className="text-sm font-semibold text-foreground">
                    <span className="inline-flex items-center gap-1.5">Vocal sound <InlineTip label="Vocal sound">Optional character and texture for the voice (e.g., raspy, soft, aggressive). Pick one or more, or type your own.</InlineTip></span>
                  </Label>
                  <Popover open={vocalOpen} onOpenChange={setVocalOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        ref={vocalPopover.triggerRef}
                        type="button"

                        variant="outline"
                        aria-labelledby="vocal-sound-label vocal-sound-trigger"
                        id="vocal-sound-trigger"
                        aria-haspopup="dialog"
                        aria-expanded={vocalOpen}
                        className="h-12 w-full justify-between border border-zinc-800 bg-zinc-950 text-base text-zinc-100 hover:bg-zinc-900 hover:text-zinc-100"
                      >
                        <span className="truncate text-left">
                          {(() => {
                            const nonGender = vocalPresets.filter(
                              (p) => !GENDER_PRESETS.includes(p as (typeof GENDER_PRESETS)[number]),
                            );
                            return nonGender.length
                              ? `${nonGender.length} sound${nonGender.length === 1 ? "" : "s"} selected`
                              : "Pick or type a vocal sound…";
                          })()}
                        </span>
                        <ChevronDown className="ml-2 size-4 shrink-0 opacity-70" aria-hidden />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      side="bottom"
                      sideOffset={6}
                      avoidCollisions={false}
                      aria-label="Vocal sound options"
                      {...vocalPopover.contentProps}
                      className={ENGINE_DROPDOWN_CLASS}
                      style={{ backgroundColor: "#09090b" }}
                    >

                      <div className="relative mb-2">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input
                          type="text"
                          role="combobox"
                          aria-label="Search or type a vocal sound"
                          aria-expanded
                          aria-controls="vocal-sound-listbox"
                          aria-autocomplete="list"
                          aria-activedescendant={vocalActiveId}
                          aria-describedby="vocal-sound-keyboard-help"
                          placeholder="Search or type a vocal sound…"
                          value={vocalSearch}
                          onChange={(e) => setVocalSearch(e.target.value)}
                          onKeyDown={onVocalSearchKeyDown}
                          autoFocus
                          className="border border-zinc-800 bg-zinc-900 pl-9 text-foreground placeholder:text-muted-foreground placeholder-dim focus-visible:border-primary focus-visible:ring-primary"
                        />
                      </div>
                      <p id="vocal-sound-keyboard-help" className="sr-only">
                        Use the up and down arrow keys to move through the list, Enter to select or
                        add your typed sound, and Escape to close.
                      </p>
                      <p className="sr-only" aria-live="polite">
                        {flatVocalRows.length} vocal sound{flatVocalRows.length === 1 ? "" : "s"}{" "}
                        available
                      </p>
                      <div
                        id="vocal-sound-listbox"
                        role="listbox"
                        aria-multiselectable="true"
                        aria-labelledby="vocal-sound-label"
                        className="engine-genre-scroll flex-1 overflow-y-auto bg-zinc-950"
                      >
                        {filteredVocalOptions.length === 0 ? (
                          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                            No preset sounds match “{vocalSearch}”
                          </p>
                        ) : (
                          (() => {
                            let rowIndex = -1;
                            return filteredVocalOptions.map((group) => {
                              const groupId = `vocal-group-${group.label.replace(/\s+/g, "-").toLowerCase()}`;
                              return (
                                <div
                                  key={group.label}
                                  role="group"
                                  aria-labelledby={groupId}
                                  className="mb-2 last:mb-0"
                                >
                                  <p
                                    id={groupId}
                                    className="px-2 py-1 text-xs font-bold uppercase tracking-wider text-muted-foreground"
                                  >
                                    {group.label}
                                  </p>
                                  {group.options.map((option) => {
                                    rowIndex += 1;
                                    const index = rowIndex;
                                    const active = vocalPresets.includes(option);
                                    const highlighted = index === vocalActiveIndex;
                                    return (
                                      <div
                                        key={option}
                                        id={`vocal-opt-${index}`}
                                        role="option"
                                        tabIndex={-1}
                                        aria-selected={active}
                                        onMouseEnter={() => setVocalActiveIndex(index)}
                                        onClick={() => toggleVocalPreset(option)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter" || e.key === " ") {
                                            e.preventDefault();
                                            toggleVocalPreset(option);
                                          }
                                        }}
                                        className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors ${
                                          active ? "bg-primary/10 text-primary" : ""
                                        } ${highlighted ? "bg-muted/50 ring-1 ring-primary/50" : ""}`}
                                      >
                                        <span
                                          className={`flex size-4 shrink-0 items-center justify-center rounded border ${
                                            active
                                              ? "border-primary bg-primary text-primary-foreground"
                                              : "border-border-strong"
                                          }`}
                                          aria-hidden
                                        >
                                          {active ? <Check className="size-3" /> : null}
                                        </span>
                                        {option}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            });
                          })()
                        )}
                        {vocalCustomEntry ? (
                          <div
                            id={`vocal-opt-${flatVocalRows.length - 1}`}
                            role="option"
                            tabIndex={-1}
                            aria-selected={false}
                            aria-label={`Add custom vocal sound ${vocalCustomEntry}`}
                            onMouseEnter={() => setVocalActiveIndex(flatVocalRows.length - 1)}
                            onClick={() => addCustomVocalSound(vocalSearch)}
                            className={`flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-primary ${
                              vocalActiveIndex === flatVocalRows.length - 1
                                ? "bg-primary/10 ring-1 ring-primary/50"
                                : ""
                            }`}
                          >
                            <Plus className="size-4" aria-hidden />
                            Add custom: {vocalCustomEntry}
                          </div>
                        ) : null}
                      </div>
                    <button
                      type="button"
                      onClick={() => {
                        setVocalOpen(false);
                        vocalPopover.closeAndReturnFocus();
                      }}
                      className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-800"
                    >
                      Done
                    </button>
                    </PopoverContent>

                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    Optional. Pick one or more — e.g. “raspy”, “soft falsetto”, “angry”. Your picks
                    appear as chips below and you can tap a chip to remove it.
                  </p>
                </div>

                {vocalPresets.filter(
                  (p) => !GENDER_PRESETS.includes(p as (typeof GENDER_PRESETS)[number]),
                ).length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {vocalPresets
                      .filter(
                        (p) => !GENDER_PRESETS.includes(p as (typeof GENDER_PRESETS)[number]),
                      )
                      .map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          aria-label={`Remove ${preset}`}
                          onClick={() => toggleVocalPreset(preset)}
                          className="rounded-full border border-primary bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/25"
                        >
                          {preset} ×
                        </button>
                      ))}
                  </div>
                ) : null}
                </div>
                ) : null}

                {vocalSource === "custom-upload" ? (
                <div className="space-y-4">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-semibold text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        Vocal gender
                        <InlineTip label="Vocal gender">
                          Optional. Choose Male or Female for the lead vocal, or leave Auto so the
                          engine decides.
                        </InlineTip>
                      </span>
                    </legend>
                    <div
                      id={VOCAL_GENDER_GROUP_ID}
                      role="radiogroup"
                      aria-label="Vocal gender"
                      className="grid gap-2 sm:grid-cols-3"
                    >
                      {VOCAL_GENDER_OPTIONS.map((option) => {
                        const selected = selectedVocalGender === option.value;
                        return (
                          <label
                            key={option.label}
                            className={`flex cursor-pointer items-center gap-2 rounded-md border-2 px-3 py-2.5 text-sm font-semibold transition-colors ${
                              selected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border-strong bg-background text-foreground hover:border-primary/60"
                            }`}
                          >
                            <input
                              type="radio"
                              name="vocal-gender"
                              value={option.value}
                              checked={selected}
                              onChange={() => setSelectedVocalGender(option.value)}
                              className="accent-primary"
                            />
                            {option.label}
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground" aria-live="polite">
                      Active tag: {vocalGenderTagLabel(selectedVocalGender)}
                    </p>
                  </fieldset>
                  <div
                    className="relative space-y-3"
                    style={{ pointerEvents: "auto" }}
                    data-pipeline-blocks-recording="false"
                  >
                  <QuickVocalRecorder
                    voiceId={voiceId}
                    vocalMode={vocalSource}
                    signedIn={signedIn}
                    selectedGender={selectedVocalGender}
                    onGenderChange={setSelectedVocalGender}
                    onVoiceIdChange={(id) => {
                      setVoiceId(id);
                      if (id) setVocalSource("custom-upload");
                    }}
                    onTermsAcceptedChange={setVocalConsent}
                    onCustomVocalIntent={() => {
                      setVocalSource("custom-upload");
                      setVocalOpen(false);
                    }}
                    onCustomFileChange={(file) => {
                      setCustomVocalFile(file);
                      setVocalAudioUrl((prev) => {
                        if (prev) URL.revokeObjectURL(prev);
                        return file ? URL.createObjectURL(file) : null;
                      });
                    }}
                  />
                  </div>
                </div>
                ) : null}
              </>
            ) : null}
            </div>
          </section>
          ) : null}

          {studioStep === 3 ? (
            <div className="relative" role="region" aria-label="Legal terms">
              <LegalDisclaimer variant="compact" bare className="text-start" />
            </div>
          ) : null}
          </div>

          <select
            id={DEFAULT_AI_VOCAL_SELECT_ID}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            value={vocalSource === "default-ai" ? "ai" : voiceId || "ai"}
            onChange={() => undefined}
          >
            <option value="ai">Default AI Vocal</option>
            {voiceId ? <option value={voiceId}>{voiceId}</option> : null}
          </select>
          <input
            id={VOCAL_CONSENT_CHECK_ID}
            type="checkbox"
            className="sr-only"
            tabIndex={-1}
            checked={vocalConsent || readStoredVocalConsent()}
            onChange={() => undefined}
            aria-hidden
          />
          <input type="hidden" id={VIDEO_PROMPT_INPUT_ID} value={showAiVocalStyling ? vocalPrompt : ""} readOnly />

          <div
            id="studio-generate-dock"
            className="relative mt-6 space-y-3 border-t border-zinc-800 pt-4"
          >
            {studioStep === STUDIO_STEPS.length - 1 ? (
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
                <h3 className="text-sm font-semibold text-foreground">Review before generate</h3>
                <dl className="grid gap-2 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-400">Title</dt>
                    <dd className="text-end text-zinc-100">{title.trim() || "Untitled"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-400">Style</dt>
                    <dd className="text-end text-zinc-100">{styleLine || "Not set"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-400">Vocals</dt>
                    <dd className="text-end text-zinc-100">{activeVocalProfile()}</dd>
                  </div>
                  {withVocals ? (
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-400">Vocal gender</dt>
                      <dd className="text-end text-zinc-100">{vocalGenderTagLabel(resolvedVocalGender())}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-400">Length</dt>
                    <dd className="text-end text-zinc-100">{formatDuration(targetDuration)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-400">Tempo</dt>
                    <dd className="text-end text-zinc-100">{bpm} BPM</dd>
                  </div>
                </dl>
                <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
                  <HybridTokenIcon className="size-4 text-primary" />
                  1 Hybrid Token · $2.00
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row">
              {studioStep > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 border-border bg-zinc-900 text-white hover:border-primary hover:bg-zinc-800 hover:text-white sm:w-36"
                  onClick={() => setStudioStep((step) => Math.max(0, step - 1))}
                >
                  Back
                </Button>
              ) : null}
              {studioStep < STUDIO_STEPS.length - 1 ? (
                <Button
                  type="button"
                  className="h-auto min-h-12 flex-1 text-sm sm:text-base"
                  disabled={studioStep === 0 ? !canProceed : false}
                  onClick={() => {
                    if (studioStep === 0) {
                      handleStep1Next();
                      return;
                    }
                    setStudioStep((step) => Math.min(STUDIO_STEPS.length - 1, step + 1));
                  }}
                >
                  {studioStep === 0 ? "Continue to Step 2" : "Continue"}
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    id={GENERATE_TRACK_BTN_ID}
                    size="lg"
                    className="h-auto min-h-12 flex-1 whitespace-normal px-4 py-3 text-sm leading-tight sm:text-base"
                    disabled={busy && !result}
                    onClick={() => void handleGenerate()}
                  >
                    {busy && !result ? (
                      <>
                        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        <span className="min-w-0 truncate">{statusText ?? "Working…"}</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4 shrink-0" aria-hidden />
                        <span>Generate Track</span>
                      </>
                    )}
                  </Button>
                  {busy && !result ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-12 border-border bg-zinc-900 text-white hover:border-destructive hover:text-destructive sm:w-44"
                      onClick={cancelGeneration}
                    >
                      Cancel Generation
                    </Button>
                  ) : null}
                </>
              )}
            </div>

          {busy && !result && statusText ? (
            <p className="text-center text-xs text-muted-foreground" role="status">
              {statusText}
            </p>
          ) : null}

          {pipelineState.status === "error" && pipelineState.lastError ? (
            <div
              className="space-y-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
              role="alert"
            >
              <p className="font-semibold">
                Pipeline failed at step:{" "}
                {displayPipelineStep(
                  pipelineState.lastError.step ||
                    readErrorStep(pipelineState.lastError.raw) ||
                    pipelineState.currentStep,
                  pipelineState.currentStep,
                )}
              </p>
              <p>{pipelineState.lastError.message}</p>
              <p className="break-all font-mono text-[11px] opacity-80">
                {previewPipelinePayload(pipelineState.lastError.raw, 240)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  setPipelineState((prev) => ({ ...prev, status: "idle", lastError: null }))
                }
              >
                Dismiss
              </Button>
            </div>
          ) : null}

          {creditsOut ? (
            <div
              className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
              role="status"
            >
              <p className="font-semibold">Engine credits unavailable</p>
              <p>{ENGINE_CREDIT_MESSAGE}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={creditCheckBusy}
                onClick={() => void refreshEngineCredits(true)}
              >
                {creditCheckBusy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-4" aria-hidden />
                )}
                Re-check engine credits
              </Button>
            </div>
          ) : null}

          {!busy && rollbackNotice ? (

            <div
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive-foreground"
              role="alert"
            >
              <p>{rollbackNotice}</p>
              {retryPlan ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => void handleRetry()}
                >
                  <RefreshCw className="size-4" aria-hidden /> {retryPlan.label}
                </Button>
              ) : null}
            </div>
          ) : null}
          </div>

        </CardContent>
      </Card>

      {result ? (
        <Card className="engine-result-card bg-zinc-900/80 backdrop-blur-md border border-zinc-800 shadow-2xl rounded-xl text-zinc-100 divide-y divide-zinc-800/50">
          <CardContent className="space-y-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <h3 className="text-base font-semibold">{result.title}</h3>
                <p className="text-xs text-muted-foreground">{result.style}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Vocal profile:</span>{" "}
                  {result.vocalProfile}
                </p>
              </div>
              <span className="rounded-full border border-primary/50 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                Mastered WAV ready
              </span>
            </div>

            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Playback stem">
              {(
                [
                  ["mastered", "Mastered", result.audioUrl],
                  ["raw", "Raw mix", result.audioUrl],
                  ["vocal", "Vocals", result.vocalUrl],
                  ["instrumental", "Instrumental", result.instrumentalUrl],
                ] as Array<[StemKind, string, string | null | undefined]>
              ).map(([kind, label, url]) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={playbackKind === kind}
                  disabled={!url}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    playbackKind === kind
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-zinc-700 text-zinc-300 hover:border-primary/50"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  onClick={() => {
                    setPlaybackKind(kind);
                    const taskId = result.taskId;
                    if (!taskId || !url) {
                      setPlaybackSrc(url ?? result.audioUrl);
                      return;
                    }
                    void stemObjectUrl(taskId, kind, url).then((next) => {
                      if (next) setPlaybackSrc(next);
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <WaveformPlayer
              key={playbackSrc ?? result.audioUrl}
              src={playbackSrc ?? result.audioUrl}
              title={result.title}
              onUrlRepaired={applyRepairedUrl}
              onRegenerate={() => void handleGenerate()}
              regenerating={busy && !result}
            />

            {result.audioUrl ? (
              <div className="flex flex-wrap gap-2">
                <a
                  href={result.audioUrl}
                  download={hybridTrackDownloadFileName(result.title)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    buttonVariants({ variant: "default", size: "sm" }),
                    "inline-flex w-fit items-center gap-2",
                  )}
                >
                  <Download className="size-3.5" aria-hidden />
                  Download Track
                </a>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleShareResult()}
                >
                  <Share2 className="size-3.5" aria-hidden />
                  Share
                </Button>
              </div>
            ) : null}


            <div className="flex flex-col gap-2">
              {(
                [
                  { label: "Master Track", url: result.audioUrl, slug: "Master" },
                  { label: "Raw Pre-Master", url: result.rawAudioUrl, slug: "Raw Pre-Master" },
                  { label: "Clean Vocal Stem", url: result.vocalUrl, slug: "Clean Vocal" },
                  {
                    label: "Instrumental Stem",
                    url: result.instrumentalUrl,
                    slug: "Instrumental",
                  },
                ] as const
              ).map(({ label, url, slug }) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <span className="text-sm text-zinc-200">{label}</span>
                  <span className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!url || exporting}
                      onClick={() => {
                        if (!url) return;
                        void downloadWav(url, `${result.title} (${slug})`);
                      }}
                    >
                      {exporting ? (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Download className="size-3.5" aria-hidden />
                      )}
                      WAV
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!url}
                      onClick={() => {
                        if (!url) return;
                        void downloadTrack(url, `${result.title} (${slug})`);
                      }}
                    >
                      <Download className="size-3.5" aria-hidden />
                      MP3
                    </Button>
                  </span>
                </div>
              ))}
              <Button type="button" variant="ghost" onClick={newTrack} className="self-start">
                <Plus className="size-4" aria-hidden /> Create New Track
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <AudioVault
        signedIn={signedIn}
        refreshKey={vaultTick}
        onDownload={(url, name) => void downloadTrack(url, name)}
      />

      {/* Top-up modal — opens whenever the balance can't cover a generation. */}
      <TokenStore open={topUpOpen} onOpenChange={setTopUpOpen} hideTrigger />
    </div>
  );

}
