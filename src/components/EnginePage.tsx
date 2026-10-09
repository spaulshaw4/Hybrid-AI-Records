import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from "react";
import { Lock, Sparkles } from "lucide-react";

import CharacterModal, {
  encodePcmWav,
  isAudioVaultHttpsUrl,
  type SelectedVocal,
  type VocalCharacter,
} from "@/components/studio/CharacterModal";
import { supabase } from "@/integrations/supabase/client";
import BuyTokensModal from "@/components/studio/BuyTokensModal";
import MyPromptsModal, { type SavedPromptItem } from "@/components/studio/MyPromptsModal";
import TemplatesModal from "@/components/studio/TemplatesModal";
import { AudioVaultList, type VaultTrackReference } from "@/components/studio/AudioVaultList";
import { DurationSlider } from "@/components/studio/DurationSlider";
import { PatriotGlassStudio } from "@/components/studio/PatriotGlassStudio";
import { StudioFooter } from "@/components/studio/StudioFooter";
import {
  ClearLyricsButton,
  VocalGenderCard,
  VocalStudioTab,
  appendAcousticTags,
  type VisualSongDraft,
  type VocalStudioReference,
} from "@/components/studio/VocalStudioTab";
import { MUREKA_TEMPLATES, type TrackTemplate } from "@/data/murekaTemplates";
import { safeCloseAudioContext } from "@/lib/safe-media";
import { waitForVaultedTrack } from "@/lib/wavespeed-track-client";

const PROMPT_RECORDS_KEY = "hybrid_prompt_records";
const VIBE_PLACEHOLDER =
  "Describe a vibe, tempo, or instruments (e.g., 90 BPM lo-fi hip hop with Rhodes piano & upright bass)...";
const VIBE_SOUND_DESIGN =
  "Act as a sound designer. Expand the rough instrumental vibe into detailed acoustic keywords: BPM, specific instrumentation, analog warmth, and rhythmic groove. No vocals.";

function vibeEnhanceSeed(rough: string): string {
  const vibe = rough.trim();
  if (!vibe) {
    return `${VIBE_SOUND_DESIGN} Invent one concrete instrumental production.`;
  }
  return `${VIBE_SOUND_DESIGN} Rough vibe: ${vibe}`;
}

function vibeEnhanceError(message: string): string {
  if (/wavespeed|mureka|replicate|claude|aimusic|fish|sonic/i.test(message)) return "Could not enhance that vibe.";
  const text = message.trim();
  return text || "Could not enhance that vibe.";
}

function studioPublicError(message: string, fallback: string): string {
  if (/wavespeed|mureka|replicate|gemini|claude|supabase|aimusic|fish|sonic/i.test(message)) return fallback;
  const text = message.trim();
  return text || fallback;
}

const compactActionClass =
  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border disabled:cursor-not-allowed disabled:opacity-60";
const badgeActionClass = `${compactActionClass} border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20`;
const renderButtonClass =
  "flex h-12 w-full items-center justify-center rounded-lg border border-red-500 bg-red-600 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-800";
const secondaryActionClass = `${compactActionClass} bg-transparent text-zinc-300 hover:bg-white/5 border-white/10`;

type StudioModal = "reference" | "visual" | null;

interface VaultTrack {
  id: string;
  title: string;
  genre: string;
  duration: string;
  status: string;
  wav_url: string;
  mp3_url: string;
}

type AttachedReference =
  | { kind: "file"; name: string; file: File }
  | { kind: "vault"; url: string; title: string };

async function uploadReferenceWav(file: File, accessToken: string): Promise<string> {
  const body = new FormData();
  body.append("audio", file, file.name || "reference.wav");
  const response = await fetch("/api/vocals/reference", {
    method: "POST",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body,
  });
  const raw = await response.text();
  let payload: { url?: unknown; error?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") payload = parsed as { url?: unknown; error?: unknown };
  } catch {
    throw new Error("Could not upload that reference.");
  }
  if (!response.ok || typeof payload.url !== "string") {
    const message = typeof payload.error === "string" ? payload.error : "Could not upload that reference.";
    throw new Error(message);
  }
  return payload.url.trim();
}

type ReferenceExtension = "wav" | "mp3" | "aac" | "m4a";

const REFERENCE_CLIP_SECONDS = 30;
const REFERENCE_SAMPLE_RATE = 24_000;

function headerText(bytes: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let index = start; index < end && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index] ?? 0);
  }
  return text;
}

function isWebmEbml(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && headerText(bytes, 0, 4) === "RIFF" && headerText(bytes, 8, 12) === "WAVE";
}

function isMpegAudio(bytes: Uint8Array): boolean {
  if (bytes.length >= 3 && headerText(bytes, 0, 3) === "ID3") return true;
  if (bytes.length < 2 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  return (bytes[1] & 0x06) !== 0;
}

function isAdtsAac(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
}

function isM4aContainer(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || headerText(bytes, 4, 8) !== "ftyp") return false;
  const brand = headerText(bytes, 8, 12);
  return brand === "M4A " || brand === "M4B " || brand === "mp41" || brand === "mp42" || brand === "isom";
}

function referenceAudioKind(file: File, bytes: Uint8Array): ReferenceExtension | null {
  if (isWebmEbml(bytes)) return null;
  if (isRiffWav(bytes)) return "wav";
  if (isMpegAudio(bytes)) return "mp3";
  if (isAdtsAac(bytes)) return "aac";
  if (isM4aContainer(bytes)) return "m4a";
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (name.endsWith(".wav") || type === "audio/wav" || type === "audio/x-wav") return "wav";
  if (name.endsWith(".mp3") || type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  if (name.endsWith(".aac") || type === "audio/aac") return "aac";
  if (name.endsWith(".m4a") || type === "audio/m4a" || type === "audio/mp4" || type === "audio/x-m4a") return "m4a";
  return null;
}

type PcmView = {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
};

/** Copy one channel into a fresh array. Never pass a subarray to copyFromChannel. */
function readChannel(audio: PcmView, channel: number, start: number, count: number): Float32Array {
  const frames = Math.max(0, Math.floor(count));
  const out = new Float32Array(frames);
  const channelCount = Math.max(0, audio.numberOfChannels);
  if (channel < 0 || (channelCount > 0 && channel >= channelCount)) return out;
  const copyFromChannel = (audio as AudioBuffer).copyFromChannel;
  if (typeof copyFromChannel === "function") {
    try {
      copyFromChannel.call(audio, out, channel, Math.max(0, Math.floor(start)));
      return out;
    } catch {
      // Mono buffers throw on a stereo index. Chrome also throws when the destination is a view.
    }
  }
  const data = audio.getChannelData(channel);
  const begin = Math.max(0, Math.floor(start));
  const end = Math.min(data.length, begin + frames);
  if (begin >= data.length || end <= begin) return out;
  try {
    out.set(data.subarray(begin, end));
  } catch {
    for (let index = begin; index < end; index += 1) out[index - begin] = data[index] ?? 0;
  }
  return out;
}

function slicePcm(audio: PcmView, frames: number): PcmView | null {
  const count = Math.max(0, Math.min(frames, audio.length));
  if (count <= 0) return null;
  const channelCount = Math.max(1, audio.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(readChannel(audio, channel, 0, count));
  }
  const sampleRate = audio.sampleRate > 0 ? audio.sampleRate : REFERENCE_SAMPLE_RATE;
  return {
    numberOfChannels: channelCount,
    length: count,
    sampleRate,
    duration: count / sampleRate,
    getChannelData: (channel) => channels[channel] ?? new Float32Array(),
  };
}

function downsamplePcm(audio: PcmView, sampleRate: number): PcmView {
  const inputRate = audio.sampleRate > 0 ? audio.sampleRate : sampleRate;
  if (inputRate === sampleRate) return audio;
  const channelCount = Math.max(1, audio.numberOfChannels);
  const length = Math.max(1, Math.round((audio.length * sampleRate) / inputRate));
  const ratio = inputRate / sampleRate;
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    const input = audio.getChannelData(channel);
    const output = new Float32Array(length);
    const last = Math.max(0, input.length - 1);
    for (let frame = 0; frame < length; frame += 1) {
      const position = frame * ratio;
      const index = Math.floor(position);
      const next = Math.min(index + 1, last);
      const frac = position - index;
      const left = input[index] ?? 0;
      const right = input[next] ?? left;
      output[frame] = left + (right - left) * frac;
    }
    channels.push(output);
  }
  return {
    numberOfChannels: channelCount,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (channel) => channels[channel] ?? new Float32Array(),
  };
}

function mixToMono(audio: PcmView): PcmView {
  const channelCount = Math.max(1, audio.numberOfChannels);
  const sampleRate = audio.sampleRate > 0 ? audio.sampleRate : REFERENCE_SAMPLE_RATE;
  if (channelCount === 1) {
    return {
      numberOfChannels: 1,
      length: audio.length,
      sampleRate,
      duration: audio.length / sampleRate,
      getChannelData: (channel) => (channel === 0 ? audio.getChannelData(0) : new Float32Array()),
    };
  }
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(audio.getChannelData(channel));
  }
  const mono = new Float32Array(audio.length);
  for (let frame = 0; frame < audio.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) sum += channels[channel]?.[frame] ?? 0;
    mono[frame] = sum / channelCount;
  }
  return {
    numberOfChannels: 1,
    length: audio.length,
    sampleRate,
    duration: audio.length / sampleRate,
    getChannelData: (channel) => (channel === 0 ? mono : new Float32Array()),
  };
}

function referenceWindow(audio: PcmView, startSeconds: number) {
  const rate = audio.sampleRate > 0 ? audio.sampleRate : REFERENCE_SAMPLE_RATE;
  const duration = audio.duration > 0 && Number.isFinite(audio.duration) ? audio.duration : audio.length / rate;
  const span = Math.min(REFERENCE_CLIP_SECONDS, Math.max(0, duration));
  const maxStart = Math.max(0, duration - span);
  const start = Math.min(Math.max(0, startSeconds), maxStart);
  return { start, end: start + span, span, maxStart, duration };
}

function slicePcmFrom(audio: PcmView, startFrame: number, frames: number): PcmView | null {
  if (!(audio.length > 0)) return null;
  const sampleRate = audio.sampleRate > 0 ? audio.sampleRate : REFERENCE_SAMPLE_RATE;
  const start = Math.max(0, Math.min(Math.floor(startFrame), Math.max(0, audio.length - 1)));
  const count = Math.max(1, Math.min(Math.floor(frames), audio.length - start));
  const channelCount = Math.max(1, audio.numberOfChannels);
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(readChannel(audio, channel, start, count));
  }
  return {
    numberOfChannels: channelCount,
    length: count,
    sampleRate,
    duration: count / sampleRate,
    getChannelData: (channel) => channels[channel] ?? new Float32Array(),
  };
}

/** Chosen 30-second window, 24 kHz, mono. Mic takes do not use this. */
function pcmForReferenceClip(audio: PcmView, startSeconds: number): PcmView | null {
  if (!audio || !(audio.length > 0)) return null;
  try {
    const rate = audio.sampleRate > 0 ? audio.sampleRate : REFERENCE_SAMPLE_RATE;
    const window = referenceWindow(audio, startSeconds);
    if (!(window.span > 0)) return null;
    const startFrame = Math.min(Math.floor(window.start * rate), Math.max(0, audio.length - 1));
    const frames = Math.max(1, Math.min(Math.round(window.span * rate) || 1, audio.length - startFrame));
    const sliced = slicePcmFrom(audio, startFrame, frames);
    if (!sliced || !(sliced.length > 0)) return null;
    const downsampled = downsamplePcm(sliced, REFERENCE_SAMPLE_RATE);
    const mono = mixToMono(downsampled);
    const maxOut = REFERENCE_CLIP_SECONDS * REFERENCE_SAMPLE_RATE;
    if (!(mono.length > 0)) return null;
    if (mono.length > maxOut) return slicePcm(mono, maxOut);
    return mono;
  } catch {
    return null;
  }
}

function ReferenceClipTimeline({
  audio,
  start,
  playing,
  onStart,
  onToggle,
}: {
  audio: PcmView;
  start: number;
  playing: boolean;
  onStart: (start: number) => void;
  onToggle: () => void;
}) {
  const window = referenceWindow(audio, start);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.16)",
            color: "#f8fafc",
            borderRadius: 8,
            padding: "6px 10px",
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span style={{ fontSize: 12, color: "#94a3b8" }}>{formatVocalReferenceClock(window.duration)}</span>
        <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
          {formatVocalReferenceClock(window.start)}–{formatVocalReferenceClock(window.end)}
        </span>
      </div>
      <input
        type="range"
        aria-label="Clip start"
        min={0}
        max={window.maxStart}
        step={0.01}
        value={window.start}
        disabled={window.maxStart <= 0}
        onChange={(event) => onStart(Number(event.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
}

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

type StagedReference = {
  name: string;
  file: File;
  audio: PcmView;
};

function safeReferenceName(originalName: string, extension: ReferenceExtension): string {
  const suffix = `.${extension}`;
  const sanitized = (originalName.trim() || "reference").replace(/[^A-Za-z0-9._-]/g, "_");
  const stem = sanitized.replace(/\.[A-Za-z0-9]+$/i, "").replace(/\.+$/g, "");
  return `${stem || "reference"}${suffix}`;
}

function canonicalStoragePath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    path = pathname;
  }
  return path.replace(/\/{2,}/g, "/");
}

function referenceEnv(name: string): string {
  try {
    const fromVite = (import.meta.env as Record<string, unknown>)[name];
    if (typeof fromVite === "string" && fromVite.trim()) return fromVite.trim();
  } catch {
    /* import.meta is unavailable outside the bundler */
  }
  if (typeof process !== "undefined" && process.env) {
    const fromProcess = process.env[name];
    if (typeof fromProcess === "string" && fromProcess.trim()) return fromProcess.trim();
  }
  return "";
}

/** Same host order as the audio-to-prompt route. Non-HTTP values are skipped. */
function referenceProjectHost(): string {
  const names = ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_URL"] as const;
  for (const name of names) {
    const raw = referenceEnv(name);
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      if (host) return host;
    } catch {
      continue;
    }
  }
  return "";
}

function blockedReferenceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "169.254.169.254") return true;
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Why a public URL was rejected. Never includes the URL or query string. */
function referenceUrlRejection(raw: string, userId: string): string {
  if (!raw) return "empty";
  if (!userId) return "no user id";
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "https:") return "protocol";
  if (parsed.username || parsed.password) return "credentials";
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (blockedReferenceHost(host)) return "blocked host";
  const expected = referenceProjectHost();
  if (expected && host !== expected) return "host";
  const path = canonicalStoragePath(parsed.pathname);
  if (path.includes("/object/sign/")) return "signed url";
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase() === "token") return "token query";
  }
  const marker = `/storage/v1/object/public/audio-vault/references/${userId}/`;
  if (!path.toLowerCase().includes(marker.toLowerCase())) return "path";
  return "";
}

/** Signed object URLs and token query params are not reference audio. */
function publicReferenceAudioUrl(raw: string, userId: string): string {
  if (referenceUrlRejection(raw, userId)) return "";
  return raw.trim();
}

/**
 * Slice while the decode context is still open. A closed or detached buffer
 * is decoded again on a new context before that context is closed.
 */
async function sliceReferenceClip(
  audio: PcmView,
  file: File,
  startSeconds: number,
  ctx: AudioContext | null,
): Promise<PcmView | null> {
  if (ctx && ctx.state === "suspended" && typeof ctx.resume === "function") {
    try {
      await ctx.resume();
    } catch {
      /* Channel copies do not need a running output device. */
    }
  }
  if (!ctx || ctx.state !== "closed") {
    const sliced = pcmForReferenceClip(audio, startSeconds);
    if (sliced && sliced.length > 0) return sliced;
  }
  console.log("[AudioRef] AudioContext", ctx?.state ?? "missing", "decoding on a live context");
  return decodeReferenceClip(file, startSeconds);
}

async function decodeReferenceClip(file: File, startSeconds: number): Promise<PcmView | null> {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  let ctx = new Ctor();
  try {
    if (ctx.state === "closed") {
      void safeCloseAudioContext(ctx);
      ctx = new Ctor();
    }
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      try {
        await ctx.resume();
      } catch {
        /* decodeAudioData can still succeed while the context is suspended. */
      }
    }
    if (ctx.state === "closed") return null;
    const bytes = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    return pcmForReferenceClip(decoded, startSeconds);
  } catch {
    return null;
  } finally {
    void safeCloseAudioContext(ctx);
  }
}

const cardStyle: CSSProperties = {
  backgroundColor: "rgba(15, 10, 20, 0.55)",
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 12,
  padding: 14,
};

const pillStyle: CSSProperties = {
  backgroundColor: "#121826",
  border: "1px solid #1e293b",
  borderRadius: 8,
  padding: "10px 8px",
  color: "#cbd5e1",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const fieldStyle: CSSProperties = {
  width: "100%",
  backgroundColor: "transparent",
  border: "none",
  color: "#f8fafc",
  outline: "none",
  resize: "none",
  fontSize: 14,
  lineHeight: 1.5,
};

function modeTabStyle(active: boolean): CSSProperties {
  return {
    backgroundColor: "transparent",
    border: "none",
    color: active ? "#f9a8d4" : "#e9d5ff",
    fontWeight: 700,
    fontSize: 15,
    borderBottom: active ? "2px solid #e11d48" : "2px solid transparent",
    paddingBottom: 6,
    cursor: "pointer",
  };
}

export function formatVocalReferenceClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

function ActiveVocalReference({ vocal, onRemove }: { vocal: SelectedVocal; onRemove: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-emerald-100">
      <span>
        🎙️ Active Vocal Reference: {vocal.name} ({formatVocalReferenceClock(vocal.duration)})
      </span>
      <span aria-hidden="true">|</span>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        className="border-0 bg-transparent p-0 font-semibold text-emerald-50 underline"
      >
        Preview
      </button>
      <span aria-hidden="true">|</span>
      <button
        type="button"
        onClick={() => {
          try {
            audioRef.current?.pause();
          } catch {
            /* jsdom has no media pause */
          }
          onRemove();
        }}
        className="border-0 bg-transparent p-0 font-semibold text-rose-200 underline"
      >
        Remove
      </button>
      <audio ref={audioRef} src={vocal.url} aria-label="Active vocal reference" onEnded={() => setPlaying(false)} />
    </div>
  );
}

function referenceForStudio(
  character: VocalCharacter | null,
  vocal: SelectedVocal | null,
  bed: VaultTrackReference | null = null,
): VocalStudioReference | undefined {
  const id = character?.vocalId.trim() ?? "";
  const personaId = id && !/^https:\/\//i.test(id) ? id : undefined;
  const dockedVocal = vocal?.isReady && isAudioVaultHttpsUrl(vocal.url) ? vocal.url.trim() : undefined;
  const bedUrl = bed && isAudioVaultHttpsUrl(bed.url) ? bed.url.trim() : undefined;
  const vocalAudioUrl = bedUrl || dockedVocal;
  const label = [character?.name, vocal?.name].filter(Boolean).join(" · ") || undefined;
  if (!label && !personaId && !vocalAudioUrl) return undefined;
  return {
    ...(label ? { label } : {}),
    ...(personaId ? { personaId } : {}),
    ...(vocalAudioUrl ? { vocalAudioUrl } : {}),
  };
}

function readPromptRecords(): SavedPromptItem[] {
  try {
    const raw = localStorage.getItem(PROMPT_RECORDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedPromptItem => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<SavedPromptItem>;
      return (
        typeof row.id === "string" &&
        typeof row.title === "string" &&
        typeof row.prompt === "string" &&
        typeof row.timestamp === "number" &&
        typeof row.isBookmarked === "boolean"
      );
    });
  } catch {
    return [];
  }
}

export function EnginePage() {
  const [activeTab, setActiveTab] = useState<"custom" | "easy" | "vocals">("easy");
  const [lyrics, setLyrics] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [userCharacters] = useState<VocalCharacter[]>([
    {
      id: "char-stephen-oct5",
      name: "My Voice - October 5",
      timbreTag: "Powerful",
      isPublished: true,
      vocalId: "vocal_stephen_oct5_master",
    },
  ]);
  const [selectedCharacter, setSelectedCharacter] = useState<VocalCharacter | null>(null);
  const [selectedVocal, setSelectedVocal] = useState<SelectedVocal | null>(null);
  const [isCharacterModalOpen, setIsCharacterModalOpen] = useState(false);
  const [isTemplatesOpen, setIsTemplatesOpen] = useState(false);
  const [isBuyTokensOpen, setIsBuyTokensOpen] = useState(false);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(true);
  const [openModal, setOpenModal] = useState<StudioModal>(null);
  const [draftReferenceFile, setDraftReferenceFile] = useState<File | null>(null);
  const [stagedReference, setStagedReference] = useState<StagedReference | null>(null);
  const [clipStart, setClipStart] = useState(0);
  const [clipPlaying, setClipPlaying] = useState(false);
  const auditionRef = useRef<{ ctx: AudioContext; source: AudioBufferSourceNode } | null>(null);
  const decodeCtxRef = useRef<AudioContext | null>(null);
  const stageSeq = useRef(0);
  const [attachedReference, setAttachedReference] = useState<AttachedReference | null>(null);
  const [isAnalyzingReference, setIsAnalyzingReference] = useState(false);
  const referenceAnalysisSeq = useRef(0);
  const [draftVisualFile, setDraftVisualFile] = useState<File | null>(null);
  const [visualName, setVisualName] = useState<string | null>(null);
  const [isInjectingVisual, setIsInjectingVisual] = useState(false);
  const visualAnalysisSeq = useRef(0);
  const [visualSongDraft, setVisualSongDraft] = useState<VisualSongDraft | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isVibeEnhancing, setIsVibeEnhancing] = useState(false);
  const [isLyricsLoading, setIsLyricsLoading] = useState(false);
  const [lyricsAssistCooling, setLyricsAssistCooling] = useState(false);
  const lyricsCooldownTimer = useRef<number | null>(null);
  const [trackLength, setTrackLength] = useState(180);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const [isMyPromptsOpen, setIsMyPromptsOpen] = useState(false);
  const [promptRecords, setPromptRecords] = useState<SavedPromptItem[]>([]);
  const [vaultTracks, setVaultTracks] = useState<VaultTrack[]>([]);
  const [vaultRevision, setVaultRevision] = useState(0);

  useEffect(() => {
    setPromptRecords(readPromptRecords());
  }, []);

  useEffect(() => {
    return () => {
      if (lyricsCooldownTimer.current !== null) window.clearTimeout(lyricsCooldownTimer.current);
      const audition = auditionRef.current;
      auditionRef.current = null;
      const decodeCtx = decodeCtxRef.current;
      decodeCtxRef.current = null;
      void safeCloseAudioContext(decodeCtx);
      if (!audition) return;
      try {
        audition.source.onended = null;
        audition.source.stop();
      } catch {
        /* already stopped */
      }
      void safeCloseAudioContext(audition.ctx);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setAuthUserId(data.session?.user?.id ?? null);
        setAuthReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthUserId(null);
        setAuthReady(true);
      });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUserId(session?.user?.id ?? null);
      setAuthReady(true);
    });
    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const syncTokenBalance = useCallback(async () => {
    if (!authReady) return;
    if (!authUserId) {
      setTokenBalance(null);
      setIsLoadingBalance(false);
      return;
    }
    setIsLoadingBalance(true);
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/user/balance?userId=${encodeURIComponent(authUserId)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await res.json().catch(() => ({}))) as { balance?: unknown };
      if (res.ok && typeof body.balance === "number") {
        setTokenBalance(body.balance);
      }
    } catch (err) {
      console.error("Failed to sync token ledger:", err);
    } finally {
      setIsLoadingBalance(false);
    }
  }, [authReady, authUserId]);

  useEffect(() => {
    void syncTokenBalance();
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "success") return;
    const timer = window.setTimeout(() => {
      void syncTokenBalance();
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [syncTokenBalance]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    const locale = document.querySelector("[data-site-nav='desktop-locale']");
    if (!page || !(locale instanceof HTMLElement)) return;
    const previous = {
      position: locale.style.position,
      zIndex: locale.style.zIndex,
      background: locale.style.background,
    };
    const apply = () => {
      const desktop = window.matchMedia("(min-width: 1024px)").matches;
      const height = desktop ? locale.getBoundingClientRect().height : 0;
      page.style.marginTop = height > 0 ? `-${height}px` : "";
      page.style.paddingTop = height > 0 ? `${24 + height}px` : "24px";
      locale.style.position = height > 0 ? "relative" : previous.position;
      locale.style.zIndex = height > 0 ? "2" : previous.zIndex;
      locale.style.background = height > 0 ? "transparent" : previous.background;
    };
    apply();
    const media = window.matchMedia("(min-width: 1024px)");
    media.addEventListener("change", apply);
    return () => {
      media.removeEventListener("change", apply);
      page.style.marginTop = "";
      page.style.paddingTop = "";
      locale.style.position = previous.position;
      locale.style.zIndex = previous.zIndex;
      locale.style.background = previous.background;
    };
  }, []);

  const handleEnhanceStyle = async () => {
    if (isAiLoading) return;
    const styleText = prompt.trim();
    const lyricsText = lyrics.trim();
    setIsAiLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enhance_style", prompt: styleText, lyrics: lyricsText }),
      });
      const rawText = await res.text();
      let data: { success?: boolean; style?: string; prompt?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { success?: boolean; style?: string; prompt?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const enhanced = (data.style || data.prompt || "").trim();
      if (!res.ok || !enhanced) {
        throw new Error(
          data.error || data.message || (res.ok ? "Style enhancement returned an empty prompt." : "AI request failed"),
        );
      }
      setPrompt(enhanced);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "AI request failed");
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleEnhanceVibe = async () => {
    if (isVibeEnhancing) return;
    const draft = prompt;
    setIsVibeEnhancing(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enhance_style",
          prompt: vibeEnhanceSeed(draft),
          lyrics: "",
        }),
      });
      const rawText = await res.text();
      let data: { success?: boolean; style?: string; prompt?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { success?: boolean; style?: string; prompt?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const enhanced = (data.style || data.prompt || "").trim();
      if (!res.ok || !enhanced) {
        throw new Error(
          data.error || data.message || (res.ok ? "Style enhancement returned an empty prompt." : "Could not enhance that vibe."),
        );
      }
      setPrompt(enhanced);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(vibeEnhanceError(message || "Could not enhance that vibe."));
    } finally {
      setIsVibeEnhancing(false);
    }
  };

  const handleLyricsAssist = async () => {
    if (isLyricsLoading || lyricsAssistCooling) return;
    const styleText = prompt;
    const draft = lyrics;
    const hasDraft = draft.trim().length > 0;
    setIsLyricsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/ai/coproducer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasDraft
            ? { action: "format_lyrics", lyrics: draft, genre: styleText }
            : { action: "generate_lyrics", topic: styleText.trim() || "Overcoming the storm", genre: styleText },
        ),
      });
      const rawText = await res.text();
      let data: { lyrics?: string; result?: string; error?: string; message?: string } = {};
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed && typeof parsed === "object") {
          data = parsed as { lyrics?: string; result?: string; error?: string; message?: string };
        }
      } catch {
        throw new Error(`Server returned non-JSON (${res.status}): ${rawText.slice(0, 120)}`);
      }
      const nextLyrics = data.lyrics || data.result || "";
      if (!res.ok || !nextLyrics.trim()) {
        throw new Error(data.error || data.message || "AI request failed");
      }
      setLyrics(nextLyrics);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(message || "AI request failed");
      if (draft.trim()) setLyrics(draft);
    } finally {
      setIsLyricsLoading(false);
      setLyricsAssistCooling(true);
      if (lyricsCooldownTimer.current !== null) window.clearTimeout(lyricsCooldownTimer.current);
      lyricsCooldownTimer.current = window.setTimeout(() => {
        lyricsCooldownTimer.current = null;
        setLyricsAssistCooling(false);
      }, 2000);
    }
  };

  const handleApplyTemplate = (tmpl: TrackTemplate) => {
    setPrompt(tmpl.prompt);
    setGender(tmpl.recommendedGender);
    setGenre(tmpl.category);
  };

  const saveRecords = (updated: SavedPromptItem[]) => {
    setPromptRecords(updated);
    localStorage.setItem(PROMPT_RECORDS_KEY, JSON.stringify(updated));
  };

  const handleManualBookmark = () => {
    const nextPrompt = prompt.trim();
    if (!nextPrompt) return;
    const existing = promptRecords.find((item) => item.prompt === nextPrompt);
    if (existing) {
      saveRecords(
        promptRecords.map((item) =>
          item.id === existing.id ? { ...item, isBookmarked: !item.isBookmarked } : item,
        ),
      );
      return;
    }
    const entry: SavedPromptItem = {
      id: Date.now().toString(),
      title: title.trim() || "Untitled",
      prompt: nextPrompt,
      timestamp: Date.now(),
      isBookmarked: true,
    };
    saveRecords([entry, ...promptRecords]);
  };

  const handleToggleBookmark = (id: string) => {
    saveRecords(
      promptRecords.map((item) => (item.id === id ? { ...item, isBookmarked: !item.isBookmarked } : item)),
    );
  };

  const stopReferenceAudition = () => {
    const audition = auditionRef.current;
    auditionRef.current = null;
    if (audition) {
      try {
        audition.source.onended = null;
        audition.source.stop();
      } catch {
        /* already stopped */
      }
      void safeCloseAudioContext(audition.ctx);
    }
    setClipPlaying(false);
  };

  const releaseDecodeContext = () => {
    const ctx = decodeCtxRef.current;
    decodeCtxRef.current = null;
    void safeCloseAudioContext(ctx);
  };

  const clearStagedReference = () => {
    stopReferenceAudition();
    releaseDecodeContext();
    stageSeq.current += 1;
    setStagedReference(null);
    setDraftReferenceFile(null);
    setClipStart(0);
  };

  const toggleReferenceAudition = () => {
    if (!stagedReference) return;
    if (auditionRef.current) {
      stopReferenceAudition();
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    let ctx = new Ctor();
    if (ctx.state === "closed") {
      void safeCloseAudioContext(ctx);
      ctx = new Ctor();
    }
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void ctx.resume().catch(() => undefined);
    }
    if (typeof ctx.createBufferSource !== "function") {
      void safeCloseAudioContext(ctx);
      return;
    }
    const window = referenceWindow(stagedReference.audio, clipStart);
    if (window.span <= 0) {
      void safeCloseAudioContext(ctx);
      return;
    }
    let source: AudioBufferSourceNode;
    try {
      source = ctx.createBufferSource();
      source.buffer = stagedReference.audio as unknown as AudioBuffer;
      source.connect(ctx.destination);
      source.start(0, window.start, window.span);
    } catch {
      void safeCloseAudioContext(ctx);
      return;
    }
    const finish = () => {
      if (auditionRef.current?.source !== source) return;
      auditionRef.current = null;
      void safeCloseAudioContext(ctx);
      setClipPlaying(false);
    };
    source.onended = finish;
    auditionRef.current = { ctx, source };
    setClipPlaying(true);
  };

  const stageReferenceFile = async (file: File) => {
    const seq = ++stageSeq.current;
    stopReferenceAudition();
    releaseDecodeContext();
    setErrorMessage(null);
    setDraftReferenceFile(file);
    setStagedReference(null);
    setClipStart(0);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (stageSeq.current !== seq) return;
    if (!referenceAudioKind(file, head)) {
      console.error("[AudioRef] gate failed: reference kind");
      setErrorMessage("Could not read that reference.");
      return;
    }
    const Ctor = audioContextCtor();
    if (!Ctor) {
      console.error("[AudioRef] gate failed: decode or slice returned null");
      setErrorMessage("Could not read that reference.");
      return;
    }
    const ctx = new Ctor();
    let retained = false;
    try {
      if (ctx.state === "closed") throw new Error("AudioContext closed");
      const bytes = await file.arrayBuffer();
      let decoded: AudioBuffer;
      try {
        decoded = await ctx.decodeAudioData(bytes.slice(0));
      } catch (error) {
        if (ctx.state !== "suspended" || typeof ctx.resume !== "function") throw error;
        await ctx.resume();
        decoded = await ctx.decodeAudioData(bytes.slice(0));
      }
      if (stageSeq.current !== seq) return;
      decodeCtxRef.current = ctx;
      retained = true;
      setStagedReference({ name: file.name || "reference.wav", file, audio: decoded });
      setClipStart(0);
    } catch {
      if (stageSeq.current === seq) {
        console.error("[AudioRef] gate failed: decode or slice returned null");
        setErrorMessage("Could not read that reference.");
      }
    } finally {
      if (!retained) void safeCloseAudioContext(ctx);
    }
  };

  const uploadStagedReference = async (staged: StagedReference, startSeconds: number, seq: number) => {
    const fail = () => {
      if (referenceAnalysisSeq.current === seq) setErrorMessage("Could not read that reference.");
    };
    try {
      await Promise.resolve();
      const sliced = await sliceReferenceClip(staged.audio, staged.file, startSeconds, decodeCtxRef.current);
      if (!sliced || !(sliced.length > 0)) {
        console.error("[AudioRef] gate failed: decode or slice returned null");
        throw new Error("Could not slice that reference.");
      }
      const body = encodePcmWav(sliced);
      console.log("[AudioRef] Sliced Blob:", body.size, body.type);
      console.log("[AudioRef] sliced buffer", sliced.duration, sliced.sampleRate);
      if (body.type !== "audio/wav" || body.size === 0) {
        const reason = body.size === 0 ? "byteLength is 0" : "blob type is not audio/wav";
        console.error("[AudioRef] refusing upload:", reason, body.size, body.type);
        throw new Error(reason);
      }
      let accessToken = "";
      let userId = "";
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data.session?.access_token?.trim() ?? "";
        userId = data.session?.user?.id?.trim() ?? "";
      } catch {
        accessToken = "";
        userId = "";
      }
      if (!accessToken || !userId) {
        console.error("[AudioRef] gate failed: no session / no user id");
        throw new Error("no session / no user id");
      }
      const safeName = safeReferenceName(staged.name || "reference", "wav");
      const filePath = `references/${userId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("audio-vault").upload(filePath, body, {
        contentType: "audio/wav",
        // references/ allows INSERT only. upsert also requires UPDATE and 403s before the API.
        upsert: false,
      });
      if (uploadError) {
        console.error("[AudioRef] Supabase upload failed:", uploadError);
        throw new Error("Supabase upload failed.");
      }
      const { data } = supabase.storage.from("audio-vault").getPublicUrl(filePath);
      const rawUrl = typeof data?.publicUrl === "string" ? data.publicUrl.trim() : "";
      if (!rawUrl) {
        console.error("[AudioRef] gate failed: getPublicUrl empty");
        throw new Error("Reference public URL was empty.");
      }
      const audioUrl = publicReferenceAudioUrl(rawUrl, userId);
      if (!audioUrl) {
        console.error("[AudioRef] gate failed: publicReferenceAudioUrl", referenceUrlRejection(rawUrl, userId));
        throw new Error("Reference public URL was rejected.");
      }
      console.log("[AudioRef]", audioUrl);
      const response = await fetch("/api/reference/audio-to-prompt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ audioUrl }),
      });
      const bodyText = await response.text();
      if (!response.ok) {
        console.error("[AudioRef] API responded:", response.status, bodyText);
        fail();
        return;
      }
      let payload: { success?: boolean; tags?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object") payload = parsed as { success?: boolean; tags?: unknown };
      } catch {
        payload = {};
      }
      if (referenceAnalysisSeq.current !== seq) return;
      const tags = typeof payload.tags === "string" ? payload.tags.trim() : "";
      if (payload.success !== true || !tags) {
        console.error("[AudioRef] gate failed: analysis payload");
        fail();
        return;
      }
      setPrompt((current) => appendAcousticTags(current, tags));
      setVisualSongDraft((current) => ({
        revision: seq,
        title: current?.title ?? "",
        lyrics: current?.lyrics ?? "",
        tags: appendAcousticTags(current?.tags ?? "", tags),
        pass: "audio",
        acousticTags: tags,
      }));
      if (referenceAnalysisSeq.current === seq) {
        releaseDecodeContext();
        setStagedReference(null);
        setDraftReferenceFile(null);
        setClipStart(0);
      }
    } catch (error) {
      console.error("[AudioRef] gate failed:", error instanceof Error ? error.message : "unexpected");
      fail();
    } finally {
      if (referenceAnalysisSeq.current === seq) setIsAnalyzingReference(false);
    }
  };

  const commitReferenceClip = () => {
    const staged = stagedReference;
    if (!staged || isAnalyzingReference) return;
    const start = clipStart;
    const seq = ++referenceAnalysisSeq.current;
    stopReferenceAudition();
    setAttachedReference({
      kind: "file",
      name: staged.name,
      file: staged.file,
    });
    setIsAnalyzingReference(true);
    setOpenModal(null);
    setErrorMessage(null);
    void uploadStagedReference(staged, start, seq);
  };

  const analyzeVisualFile = async (file: File) => {
    const seq = ++visualAnalysisSeq.current;
    setIsInjectingVisual(true);
    setErrorMessage(null);
    try {
      let accessToken = "";
      try {
        const { data } = await supabase.auth.getSession();
        accessToken = data.session?.access_token?.trim() ?? "";
      } catch {
        accessToken = "";
      }
      const body = new FormData();
      body.append("file", file, file.name || "image.png");
      const response = await fetch("/api/reference/visual-injection", {
        method: "POST",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        body,
      });
      const raw = await response.text();
      let payload: { success?: boolean; title?: unknown; tags?: unknown; lyrics?: unknown } = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          payload = parsed as { success?: boolean; title?: unknown; tags?: unknown; lyrics?: unknown };
        }
      } catch {
        payload = {};
      }
      if (visualAnalysisSeq.current !== seq) return;
      const nextTitle = typeof payload.title === "string" ? payload.title.trim() : "";
      const nextTags = typeof payload.tags === "string" ? payload.tags.trim() : "";
      const nextLyrics = typeof payload.lyrics === "string" ? payload.lyrics.trim() : "";
      if (!response.ok || payload.success !== true || !nextTitle || !nextTags || !nextLyrics) {
        setErrorMessage("Could not read that image.");
        return;
      }
      setTitle(nextTitle);
      setLyrics(nextLyrics);
      setPrompt(nextTags);
      setVisualSongDraft({ revision: seq, title: nextTitle, lyrics: nextLyrics, tags: nextTags });
    } catch {
      if (visualAnalysisSeq.current === seq) setErrorMessage("Could not read that image.");
    } finally {
      if (visualAnalysisSeq.current === seq) setIsInjectingVisual(false);
    }
  };

  const handleGenerate = async (event: FormEvent | MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (isGenerating) return;
    const styleValue = (prompt ?? "").trim();
    const lyricValue = (lyrics ?? "").trim();
    const duration = trackLength || 180;
    const songTitle = title.trim() || "Feel It in the Rain";
    if (activeTab !== "easy" && !styleValue && !lyricValue) {
      console.error("HALT: Attempted to submit with empty prompt and lyrics.");
      alert("Generation halted: Lyrics or style prompt are empty. Check your input to avoid burning API credits.");
      return;
    }
    if (activeTab !== "easy" && !lyricValue) {
      console.error("HALT: Attempted to render a vocal master without lyrics.");
      alert("Generation halted: add lyrics before rendering a vocal master.");
      return;
    }
    if (activeTab === "easy" && !styleValue) {
      console.error("HALT: Attempted to submit an instrumental with an empty style prompt.");
      alert("Generation halted: Lyrics or style prompt are empty. Check your input to avoid burning API credits.");
      return;
    }
    const effectivePrompt = styleValue;
    const effectiveTitle = songTitle;
    if (effectivePrompt) {
      const historyEntry: SavedPromptItem = {
        id: Date.now().toString(),
        title: effectiveTitle,
        prompt: effectivePrompt,
        timestamp: Date.now(),
        isBookmarked: false,
      };
      saveRecords([historyEntry, ...promptRecords.filter((item) => item.prompt !== effectivePrompt)]);
    }
    setIsGenerating(true);
    setErrorMessage(null);
    console.log("READY TO DISPATCH:", { title, prompt: styleValue, lyrics: lyricValue, duration });
    console.log("=== SENDING TO BACKEND ===", { prompt: styleValue, lyrics: lyricValue, duration, title: songTitle });
    let ownerId = authUserId?.trim() ?? "";
    let accessToken = "";
    try {
      const { data } = await supabase.auth.getSession();
      const liveId = data.session?.user?.id?.trim() ?? "";
      accessToken = data.session?.access_token?.trim() ?? "";
      if (liveId) ownerId = liveId;
    } catch {
      /* keep the id already held in state */
    }
    if (ownerId && ownerId !== authUserId) setAuthUserId(ownerId);
    try {
      if (activeTab === "easy" || activeTab === "custom") {
        const murekaBody =
          activeTab === "easy"
            ? {
                prompt: styleValue,
                stylePrompt: styleValue,
                title: songTitle,
                isInstrumental: true,
                provider: "wavespeed",
                model: "mureka-9.5",
              }
            : {
                prompt: styleValue,
                stylePrompt: styleValue,
                title: songTitle,
                lyrics: lyricValue,
                gender,
                provider: "wavespeed",
                model: "mureka-9.5",
              };
        const res = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(murekaBody),
        });
        const data = (await res.json()) as {
          success?: boolean;
          status?: string;
          taskId?: string;
          error?: string;
          wavUrl?: string;
          mp3Url?: string;
        };
        if (!res.ok || !data.success) {
          throw new Error(studioPublicError(data.error || "", "Generation rejected by upstream engine"));
        }
        let wavUrl = data.wavUrl ?? "";
        const localId = data.taskId ? `local-${data.taskId}` : `local-${Date.now()}`;
        if (data.status === "pending" && data.taskId) {
          setVaultTracks((current) => [
            {
              id: localId,
              title: effectiveTitle,
              genre: effectivePrompt.slice(0, 24),
              duration: "210s",
              status: "Rendering",
              wav_url: "",
              mp3_url: "",
            },
            ...current,
          ]);
          try {
            const ready = await waitForVaultedTrack(data.taskId);
            wavUrl = ready.wavUrl;
          } catch (waitErr: unknown) {
            setVaultTracks((current) =>
              current.map((row) => (row.id === localId ? { ...row, status: "Failed" } : row)),
            );
            throw waitErr;
          }
        }
        if (!wavUrl) {
          throw new Error(studioPublicError(data.error || "", "Generation rejected by upstream engine"));
        }
        setVaultTracks((current) => current.filter((row) => row.id !== localId));
        setVaultRevision((value) => value + 1);
        return;
      }

      if (activeTab !== "vocals") return;

      let referenceAudioUrl = "";
      if (attachedReference) {
        const rawUrl =
          attachedReference.kind === "file"
            ? await uploadReferenceWav(attachedReference.file, accessToken)
            : attachedReference.url;
        if (!isAudioVaultHttpsUrl(rawUrl)) {
          throw new Error("Reference audio must be a public audio-vault URL.");
        }
        referenceAudioUrl = rawUrl.trim();
      }
      const vocalRes = await fetch("/api/vocals/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          title: songTitle,
          lyrics: lyricValue,
          vocalGender: gender === "female" ? "Female Vocal" : "Male Vocal",
          styleTags: styleValue,
          duration,
          ...(referenceAudioUrl ? { reference_audio_url: referenceAudioUrl } : {}),
          ...(selectedCharacter && selectedCharacter.vocalId && !/^https:\/\//i.test(selectedCharacter.vocalId)
            ? { personaId: selectedCharacter.vocalId.trim() }
            : {}),
        }),
      });
      const vocalData = (await vocalRes.json().catch(() => ({}))) as {
        success?: boolean;
        taskId?: string;
        error?: string;
      };
      if (!vocalRes.ok || vocalData.success !== true || !vocalData.taskId) {
        throw new Error(studioPublicError(vocalData.error || "", "Could not attach that reference."));
      }
      const vocalLocalId = `local-${vocalData.taskId}`;
      setVaultTracks((current) => [
        {
          id: vocalLocalId,
          title: effectiveTitle,
          genre: effectivePrompt.slice(0, 24),
          duration: "210s",
          status: "Rendering",
          wav_url: "",
          mp3_url: "",
        },
        ...current,
      ]);
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      setErrorMessage(studioPublicError(message, "An unexpected error occurred during synthesis."));
    } finally {
      setIsGenerating(false);
    }
  };

  const customCreateDisabled = isGenerating || (!prompt.trim() && !lyrics.trim());
  const styleAssistLabel = prompt.trim() ? "Expand Style" : lyrics.trim() ? "Match Lyrics" : "Surprise Me";
  const lyricsAssistLabel = isLyricsLoading
    ? lyrics.trim()
      ? "Polishing..."
      : "Drafting..."
    : lyrics.trim()
      ? "\u2726 Format & Polish"
      : "Studio Ghostwriter";
  const lyricsAssistDisabled = isLyricsLoading || lyricsAssistCooling;
  const vocalGenderCard =
    activeTab !== "easy" ? <VocalGenderCard vocalsEnabled gender={gender} onChange={setGender} /> : null;

  const vocalLockTitle =
    activeTab === "easy"
      ? "Vocals disabled in Instrumental mode"
      : activeTab === "custom"
        ? "Vocals disabled in instrumental mode"
        : undefined;
  const vocalsLocked = vocalLockTitle !== undefined;
  const vocalLabel = selectedVocal?.name
    ? `✓ ${selectedVocal.name}`
    : selectedCharacter
      ? `✓ ${selectedCharacter.name}`
      : "+ Vocal";
  const vocalButtonStyle: CSSProperties = selectedVocal || selectedCharacter
    ? {
        ...pillStyle,
        backgroundColor: "rgba(6,182,212,0.15)",
        border: "1px solid #06b6d4",
        color: "#06b6d4",
      }
    : pillStyle;

  return (
    <main
      ref={pageRef}
      className="min-h-screen overflow-y-auto"
      style={{
        minHeight: "100vh",
        color: "#f8fafc",
        colorScheme: "dark",
        position: "relative",
        zIndex: 1,
        background: "transparent",
        padding: "24px 16px 120px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <PatriotGlassStudio>
        <div className="mb-[18px] flex flex-col gap-3 border-b border-[rgba(244,114,182,0.35)] pb-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0">
          <div className="flex items-center justify-between mb-2">
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-zinc-900 border border-zinc-700/60 shadow-inner">
              <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[11px] font-mono tracking-wider font-semibold text-zinc-300 uppercase">
                Hybrid Engine 2.0
              </span>
            </div>
          </div>
          <div
            className="flex flex-row gap-6 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label="Studio mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "easy"}
              onClick={() => {
                setActiveTab("easy");
                setIsCharacterModalOpen(false);
              }}
              className="shrink-0 whitespace-nowrap"
              style={modeTabStyle(activeTab === "easy")}
            >
              Instrumental
            </button>
            <button
              type="button"
              role="tab"
              value="custom"
              aria-selected={activeTab === "custom"}
              onClick={() => {
                setActiveTab("custom");
                setIsCharacterModalOpen(false);
              }}
              className="shrink-0 whitespace-nowrap"
              style={{ ...modeTabStyle(activeTab === "custom"), whiteSpace: "nowrap" }}
            >
              Vocals with AI
            </button>
            <button type="button" role="tab" value="vocals" aria-selected={activeTab === "vocals"} onClick={() => setActiveTab("vocals")} className="shrink-0 whitespace-nowrap" style={{ ...modeTabStyle(activeTab === "vocals"), whiteSpace: "nowrap" }}>
              With Vocals
            </button>
          </div>
          </div>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                backgroundColor: "rgba(225, 29, 72, 0.12)",
                border: "1px solid rgba(225, 29, 72, 0.45)",
                borderRadius: 20,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 700,
                color: "#fda4af",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 900 }}>Ⓗ</span>
              <span>
                {isLoadingBalance
                  ? "Syncing..."
                  : `${tokenBalance ?? 0} Hybrid Token${tokenBalance === 1 ? "" : "s"}`}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsBuyTokensOpen(true)}
              style={{
                background: "transparent",
                border: "none",
                color: "#f43f5e",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Buy tokens
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16 }}>
          {attachedReference ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/50 border border-red-500/60 text-xs text-red-200">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full bg-red-500 ${isAnalyzingReference ? "animate-ping" : "animate-pulse"}`}
                aria-hidden="true"
              />
              <span className="font-mono truncate max-w-[140px]">
                {isAnalyzingReference
                  ? "Analyzing reference..."
                  : attachedReference.kind === "file"
                    ? attachedReference.name
                    : attachedReference.title}
              </span>
              {isAnalyzingReference ? null : (
                <button
                  type="button"
                  title="Remove reference"
                  aria-label="Remove reference"
                  onClick={() => {
                    clearStagedReference();
                    setAttachedReference(null);
                  }}
                  className="shrink-0 border-0 bg-transparent p-0 text-xs text-red-200"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => setOpenModal("reference")} style={pillStyle}>
              + Reference
            </button>
          )}
          {visualName ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/40 border border-red-500/50 text-xs text-red-200">
              <span
                className={`h-2 w-2 shrink-0 rounded-full bg-red-500 ${isInjectingVisual ? "animate-ping" : "animate-pulse"}`}
                aria-hidden="true"
              />
              <span className="font-mono tracking-wide font-medium truncate max-w-[130px]">
                {isInjectingVisual ? "Processing Visual..." : "Visual Injected"}
              </span>
              {isInjectingVisual ? null : (
                <button
                  type="button"
                  title="Remove visual reference"
                  aria-label="Remove visual reference"
                  onClick={() => setVisualName(null)}
                  className="shrink-0 border-0 bg-transparent p-0 text-xs text-red-200"
                >
                  ✕
                </button>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftVisualFile(null);
                setOpenModal("visual");
              }}
              style={pillStyle}
            >
              + Visual Injection
            </button>
          )}
          <span
            title={vocalLockTitle}
            style={{ display: "flex" }}
          >
            <button
              type="button"
              disabled={vocalsLocked}
              aria-disabled={vocalsLocked}
              title={vocalLockTitle}
              onClick={() => {
                if (vocalsLocked) return;
                setIsCharacterModalOpen(true);
              }}
              style={{
                ...vocalButtonStyle,
                width: "100%",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                cursor: vocalsLocked ? "not-allowed" : "pointer",
                opacity: vocalsLocked ? 0.7 : 1,
              }}
            >
              {vocalsLocked ? <Lock size={14} aria-hidden="true" /> : null}
              {vocalsLocked ? "+ Vocal" : vocalLabel}
            </button>
          </span>
        </div>

        {errorMessage ? (
          <div
            role="status"
            style={{
              backgroundColor: "#3f1d24",
              border: "1px solid #7f1d1d",
              color: "#fecaca",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 16,
              fontSize: 13,
            }}
          >
            <strong>Notice:</strong> {errorMessage}
          </div>
        ) : null}

        {activeTab === "vocals" ? (
          <>
            <VocalStudioTab
              songDraft={visualSongDraft}
              reference={referenceForStudio(
                selectedCharacter,
                selectedVocal,
                attachedReference?.kind === "vault" ? attachedReference : null,
              )}
              vocalReference={
                selectedVocal ? (
                  <ActiveVocalReference vocal={selectedVocal} onRemove={() => setSelectedVocal(null)} />
                ) : null
              }
            />
          </>
        ) : activeTab === "easy" ? (
          <div className="flex flex-col gap-4">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <h2
                style={{
                  margin: 0,
                  background: "transparent",
                  color: "#94a3b8",
                  WebkitTextFillColor: "#94a3b8",
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0,
                  textShadow: "none",
                }}
              >
                Start with a template
              </h2>
              <button
                type="button"
                onClick={() => setIsTemplatesOpen(true)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#94a3b8",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                View more ›
              </button>
            </div>
            <div
              aria-label="Template carousel"
              style={{
                display: "flex",
                gap: 10,
                overflowX: "auto",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
              }}
            >
              {MUREKA_TEMPLATES.slice(0, 5).map((tmpl) => (
                <button
                  key={tmpl.id}
                  type="button"
                  onClick={() => handleApplyTemplate(tmpl)}
                  style={{
                    minWidth: 175,
                    maxWidth: 175,
                    flex: "0 0 auto",
                    backgroundColor: "rgba(20, 12, 22, 0.6)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 10,
                    padding: 12,
                    cursor: "pointer",
                    textAlign: "left",
                    color: "#f8fafc",
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {tmpl.title}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: "#94a3b8",
                      lineHeight: 1.35,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {tmpl.subtitle}
                  </div>
                </button>
              ))}
            </div>
            <div
              style={{
                backgroundColor: "rgba(18, 12, 22, 0.65)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
                padding: 14,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  disabled={isVibeEnhancing}
                  aria-busy={isVibeEnhancing}
                  onClick={() => void handleEnhanceVibe()}
                  className={badgeActionClass}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {isVibeEnhancing ? "Enhancing..." : "Enhance Vibe"}
                </button>
              </div>
              <input
                aria-label="What's the vibe?"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={VIBE_PLACEHOLDER}
                style={{
                  width: "100%",
                  background: "transparent",
                  backgroundColor: "transparent",
                  border: "none",
                  color: "#f8fafc",
                  fontSize: 14,
                  outline: "none",
                  padding: 0,
                }}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div style={cardStyle}>
                <DurationSlider maxSeconds={360} value={trackLength} onChange={setTrackLength} />
              </div>
            </div>
            <button
              type="button"
              disabled={isGenerating || !prompt.trim()}
              onClick={(event) => void handleGenerate(event)}
              className={renderButtonClass}
            >
              {isGenerating ? "Synthesizing & Vaulting..." : "Render Master Record"}
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void handleGenerate(event)} className="flex flex-col gap-4">
            <div style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px" }}>
              <input
                type="text"
                aria-label="Song title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Enter song title"
                maxLength={50}
                style={{ backgroundColor: "transparent", border: "none", color: "#f8fafc", outline: "none", fontSize: 14, width: "80%" }}
              />
              <span style={{ fontSize: 12, color: "#64748b" }}>{title.length}/50</span>
            </div>
            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 700 }}>Lyrics & Structure</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    disabled={lyricsAssistDisabled}
                    aria-label={lyrics.trim() ? "Format and polish lyrics" : undefined}
                    onClick={() => void handleLyricsAssist()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-500/40 bg-red-950/30 text-xs font-medium text-red-200 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    {lyricsAssistLabel}
                  </button>
                  <ClearLyricsButton lyrics={lyrics} onClear={() => setLyrics("")} />
                </div>
              </div>
              <textarea
                aria-label="Lyrics"
                value={lyrics}
                onChange={(event) => setLyrics(event.target.value)}
                placeholder="Enter lyrics..."
                rows={5}
                style={fieldStyle}
              />
            </div>

            <div style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Musical Style</span>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={isAiLoading}
                    onClick={() => void handleEnhanceStyle()}
                    className={badgeActionClass}
                  >
                    {isAiLoading ? "Designing..." : styleAssistLabel}
                  </button>
                  <button type="button" onClick={() => setIsTemplatesOpen(true)} className={secondaryActionClass}>
                    Templates
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPromptRecords(readPromptRecords());
                      setIsMyPromptsOpen(true);
                    }}
                    className={secondaryActionClass}
                  >
                    Saved
                  </button>
                </div>
              </div>
              <textarea
                aria-label="Style"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Genre, mood, or instruments — or try Match Lyrics or Surprise Me"
                maxLength={1000}
                rows={4}
                style={fieldStyle}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, borderTop: "1px solid #1e293b", paddingTop: 10, fontSize: 12, color: "#64748b" }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={handleManualBookmark}
                    title="Bookmark this prompt"
                    aria-label="Bookmark this prompt"
                    style={{ backgroundColor: "transparent", border: "none", color: "#f43f5e", cursor: "pointer", fontSize: 14 }}
                  >
                    🔖
                  </button>
                  <button
                    type="button"
                    onClick={() => setPrompt("")}
                    aria-label="Clear style"
                    style={{ backgroundColor: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: 14 }}
                  >
                    🗑️
                  </button>
                </div>
                <span>{prompt.length}/1000</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              {vocalGenderCard}
              <div style={{ ...cardStyle, flex: "1 1 280px" }}>
                <DurationSlider value={trackLength} onChange={setTrackLength} />
              </div>
            </div>

            <button
              type="submit"
              disabled={customCreateDisabled}
              className={renderButtonClass}
            >
              {isGenerating ? "Synthesizing & Vaulting..." : "Render Master Record"}
            </button>
          </form>
        )}
        </PatriotGlassStudio>

        <section style={{ ...cardStyle, marginTop: 24 }} aria-label="Your Audio Vault">
          <AudioVaultList
            revision={vaultRevision}
            pending={vaultTracks
              .filter((row) => row.status === "Rendering" || row.status === "Failed")
              .map((row) => ({ id: row.id, title: row.title, status: row.status, genre: row.genre }))}
          />
        </section>

        <TemplatesModal isOpen={isTemplatesOpen} onClose={() => setIsTemplatesOpen(false)} onSelectTemplate={handleApplyTemplate} />
        <BuyTokensModal isOpen={isBuyTokensOpen} onClose={() => setIsBuyTokensOpen(false)} />

        {openModal === "reference" ? (
          <div
            role="presentation"
            onClick={() => {
              stopReferenceAudition();
              setOpenModal(null);
            }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              background: "rgba(0,0,0,0.8)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Reference"
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 440,
                background: "#141018",
                color: "#f8fafc",
                border: "1px solid rgba(225, 29, 72, 0.4)",
                borderRadius: 12,
                padding: 22,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Reference</h2>
                <button
                  type="button"
                  onClick={() => {
                    stopReferenceAudition();
                    setOpenModal(null);
                  }}
                  aria-label="Close reference"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#f8fafc",
                    fontSize: 18,
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45 }}>
                Add a reference recording. Nothing is uploaded until you choose Use Clip.
              </p>
              <input
                id="ref-audio-upload"
                type="file"
                accept="audio/wav,audio/mp3,audio/mpeg,audio/aac,audio/m4a,.wav,.mp3,.aac,.m4a"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void stageReferenceFile(file);
                }}
                style={{ display: "none" }}
              />
              <label
                htmlFor="ref-audio-upload"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  border: "1px dashed rgba(225, 29, 72, 0.5)",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 8,
                  padding: "24px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <span aria-hidden="true">🎧</span>
                <span>{draftReferenceFile ? `Selected: ${draftReferenceFile.name}` : "Click here to add a reference"}</span>
                <span style={{ color: "#64748b", fontSize: 11 }}>Supports MP3, WAV, AAC, FLAC, M4A</span>
              </label>
              {stagedReference ? (
                <ReferenceClipTimeline
                  audio={stagedReference.audio}
                  start={clipStart}
                  playing={clipPlaying}
                  onStart={(next) => {
                    stopReferenceAudition();
                    setClipStart(next);
                  }}
                  onToggle={toggleReferenceAudition}
                />
              ) : null}
              {stagedReference ? (
                <button
                  type="button"
                  onClick={commitReferenceClip}
                  style={{
                    width: "100%",
                    background: "linear-gradient(90deg, #e11d48, #be123c)",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: 8,
                    padding: "12px 0",
                    fontSize: 14,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Use Clip
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {openModal === "visual" ? (
          <div
            role="presentation"
            onClick={() => setOpenModal(null)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              background: "rgba(0,0,0,0.8)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Visual Injection"
              onClick={(event) => event.stopPropagation()}
              style={{
                width: "100%",
                maxWidth: 440,
                background: "#141018",
                color: "#f8fafc",
                border: "1px solid rgba(225, 29, 72, 0.4)",
                borderRadius: 12,
                padding: 22,
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Visual Injection</h2>
                <button
                  type="button"
                  onClick={() => setOpenModal(null)}
                  aria-label="Close visual"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#f8fafc",
                    fontSize: 18,
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: "#e2e8f0", lineHeight: 1.45 }}>
                Add a cover image. Nothing is sent until you choose Done.
              </p>
              <input
                id="visual-injection-upload"
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) setDraftVisualFile(file);
                }}
                style={{ display: "none" }}
              />
              <label
                htmlFor="visual-injection-upload"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  border: "1px dashed rgba(225, 29, 72, 0.5)",
                  background: "rgba(255,255,255,0.02)",
                  borderRadius: 8,
                  padding: "24px 16px",
                  cursor: "pointer",
                  textAlign: "center",
                }}
              >
                <span>{draftVisualFile ? draftVisualFile.name : "Click here to add an image"}</span>
                <span style={{ color: "#64748b", fontSize: 11 }}>PNG, JPG, or WebP</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  const file = draftVisualFile;
                  if (!file) {
                    setOpenModal(null);
                    return;
                  }
                  setVisualName(file.name || "image.png");
                  setIsInjectingVisual(true);
                  setOpenModal(null);
                  void analyzeVisualFile(file);
                }}
                style={{
                  width: "100%",
                  background: "linear-gradient(90deg, #e11d48, #be123c)",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 0",
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}

        <MyPromptsModal
          isOpen={isMyPromptsOpen}
          onClose={() => setIsMyPromptsOpen(false)}
          items={promptRecords}
          onSelectPrompt={(loadedPrompt) => setPrompt(loadedPrompt)}
          onToggleBookmark={handleToggleBookmark}
        />
        <CharacterModal
          isOpen={isCharacterModalOpen}
          onClose={() => setIsCharacterModalOpen(false)}
          characters={userCharacters}
          selectedCharacterId={selectedCharacter?.id || null}
          selectedSourceUrl={selectedVocal?.url ?? null}
          onSelectCharacter={(char) => setSelectedCharacter(char)}
          onSelectVocal={setSelectedVocal}
        />
      </div>
      <StudioFooter />
    </main>
  );
}
