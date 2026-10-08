import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { AudioWaveform, Mic, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { safeCloseAudioContext } from "@/lib/safe-media";

export interface VocalCharacter {
  id: string;
  name: string;
  timbreTag: string;
  isPublished: boolean;
  avatarUrl?: string;
  vocalId: string;
}

export type VocalSourceSelection = {
  url: string;
  label: string;
};

export type SelectedVocal = {
  url: string;
  name: string;
  duration: number;
  isReady: boolean;
};

interface CharacterModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: VocalCharacter[];
  selectedCharacterId: string | null;
  onSelectCharacter: (char: VocalCharacter) => void;
  onSelectSource?: (source: VocalSourceSelection | null) => void;
  onSelectVocal?: (vocal: SelectedVocal | null) => void;
  selectedSourceUrl?: string | null;
}

type VaultChoice = {
  id: string;
  title: string;
  url: string;
};

type VaultPage = PromiseLike<{
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}>;

type VaultOrdered = {
  order: (column: string, options: { ascending: boolean }) => {
    limit: (count: number) => VaultPage;
  };
};

type VaultQuery = {
  select: (columns: string) => VaultOrdered & {
    eq: (column: string, value: string) => VaultOrdered;
  };
};

const MIN_RECORD_MS = 15_000;
const RECORD_LIMIT_MS = 30_000;
const VOCAL_READY_MS = 400;
const SHORT_TAKE_WARNING = "Sonic requires at least 15 seconds of audio for accurate voice profiling.";

function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  );
}

/** 16-bit PCM WAV. Channel samples are interleaved, little-endian. */
function encodePcmWav(audio: AudioBuffer): Blob {
  const channelCount = Math.max(1, audio.numberOfChannels);
  const frames = audio.length;
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channels.push(audio.getChannelData(channel));
  }
  const blockAlign = channelCount * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel]?.[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Decode a MediaRecorder blob (audio/webm in Chromium) into a PCM WAV. */
async function recordingToWavBlob(source: Blob): Promise<Blob> {
  const Ctor = audioContextCtor();
  if (!Ctor) throw new Error("This browser can't encode a vocal take.");
  const ctx = new Ctor();
  try {
    const bytes = await source.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    return encodePcmWav(decoded);
  } finally {
    void safeCloseAudioContext(ctx);
  }
}

type StopReason = "user" | "limit" | "discard";

type CapturedTake = {
  blob: Blob;
  preview: string;
  seconds: number;
};

function drawTakeWaveform(canvas: HTMLCanvasElement, audio: AudioBuffer) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = 320;
  const height = 48;
  canvas.width = width;
  canvas.height = height;
  const data = audio.getChannelData(0);
  const buckets = 48;
  const size = Math.max(1, Math.floor(data.length / buckets));
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fb7185";
  for (let i = 0; i < buckets; i += 1) {
    let peak = 0;
    for (let j = 0; j < size; j += 1) {
      const sample = Math.abs(data[i * size + j] ?? 0);
      if (sample > peak) peak = sample;
    }
    const bar = Math.max(2, peak * (height - 4));
    const x = (width / buckets) * i;
    ctx.fillRect(x, (height - bar) / 2, Math.max(1, width / buckets - 1), bar);
  }
}

function TakeAudition({ blob, src }: { blob: Blob; src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let ctx: AudioContext | null = null;
    void (async () => {
      try {
        const Ctx =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;
        ctx = new Ctx();
        const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
        if (cancelled) return;
        drawTakeWaveform(canvas, decoded);
      } catch {
        // Playback still uses the blob URL when the buffer cannot be decoded.
      } finally {
        if (ctx) void safeCloseAudioContext(ctx);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

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
    <div className="flex flex-col gap-2">
      <canvas ref={canvasRef} aria-hidden="true" className="h-12 w-full rounded bg-black/40" />
      <audio ref={audioRef} src={src} aria-label="Captured vocal" preload="auto" onEnded={() => setPlaying(false)} />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="w-fit rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-100"
      >
        {playing ? "Pause" : "Play"}
      </button>
    </div>
  );
}

export function isAudioVaultHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname.includes("/audio-vault/");
  } catch {
    return false;
  }
}

function publicAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^https:\/\//i.test(text)) return text;
  if (text.includes("/storage/v1/object/")) return text.startsWith("https://") ? text : null;
  const path = text.replace(/^\/+/, "");
  if (!path || path.includes("..")) return null;
  const { data } = supabase.storage.from("audio-vault").getPublicUrl(path);
  return data.publicUrl?.startsWith("https://") ? data.publicUrl : null;
}

function choiceFromRow(row: Record<string, unknown>): VaultChoice | null {
  const id = typeof row.id === "string" && row.id ? row.id : typeof row.task_id === "string" ? row.task_id : "";
  if (!id) return null;
  const url = publicAudioUrl(row.wav_url) || publicAudioUrl(row.mp3_url);
  if (!url) return null;
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled Master";
  return { id, title, url };
}

async function loadVaultChoices(): Promise<VaultChoice[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUser = sessionData.session?.user;
  const accessToken = sessionData.session?.access_token?.trim() ?? "";
  let rows: Array<Record<string, unknown>> = [];
  if (sessionUser?.id) {
    const query = await (supabase as unknown as { from: (table: string) => VaultQuery })
      .from("vaulted_tracks")
      .select("id, title, prompt, wav_url, mp3_url, created_at, user_id")
      .eq("user_id", sessionUser.id)
      .order("created_at", { ascending: false })
      .limit(20);
    if (!query.error && Array.isArray(query.data) && query.data.length > 0) {
      rows = query.data;
    }
  }
  if (rows.length === 0) {
    const response = accessToken
      ? await fetch("/api/vault", { headers: { Authorization: `Bearer ${accessToken}` } })
      : await fetch("/api/vault");
    if (!response.ok) throw new Error("Could not load the vault.");
    const payload: unknown = await response.json();
    rows =
      payload && typeof payload === "object" && Array.isArray((payload as { tracks?: unknown }).tracks)
        ? (payload as { tracks: Array<Record<string, unknown>> }).tracks
        : [];
  }
  return rows.flatMap((row) => {
    const choice = choiceFromRow(row);
    return choice ? [choice] : [];
  });
}

function fileExtension(file: File): "wav" | "mp3" | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".mp3") || file.type === "audio/mpeg" || file.type === "audio/mp3") return "mp3";
  if (name.endsWith(".wav") || file.type === "audio/wav" || file.type === "audio/x-wav" || file.type === "audio/wave") {
    return "wav";
  }
  return null;
}

export default function CharacterModal({
  isOpen,
  onClose,
  characters,
  selectedCharacterId,
  onSelectCharacter,
  onSelectSource,
  onSelectVocal,
  selectedSourceUrl = null,
}: CharacterModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const startedAtRef = useRef<number | null>(null);
  const pendingDurationMsRef = useRef(0);
  const stopReasonRef = useRef<StopReason>("user");
  const uploadSerialRef = useRef(0);
  const savingTakeRef = useRef(false);
  const vocalReadyRef = useRef(false);
  const readyTimerRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const appliedReferenceRef = useRef<string | null>(null);
  const onSelectSourceRef = useRef(onSelectSource);
  const onSelectVocalRef = useRef(onSelectVocal);
  const selectedSourceUrlRef = useRef(selectedSourceUrl);
  const stopRecordingRef = useRef<(reason?: StopReason) => void>(() => {});
  const openRef = useRef(isOpen);
  const startingRef = useRef(false);
  const takeSerialRef = useRef(0);
  onSelectSourceRef.current = onSelectSource;
  onSelectVocalRef.current = onSelectVocal;
  selectedSourceUrlRef.current = selectedSourceUrl;
  openRef.current = isOpen;
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [captured, setCaptured] = useState<CapturedTake | null>(null);
  const [shortTakeWarning, setShortTakeWarning] = useState("");
  const [recordError, setRecordError] = useState("");
  const [vaultTracks, setVaultTracks] = useState<VaultChoice[]>([]);
  const [vaultError, setVaultError] = useState("");
  const [vaultLoading, setVaultLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [stagingTake, setStagingTake] = useState(false);
  const [vocalReady, setVocalReady] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const clearRecordTimers = () => {
    if (stopTimerRef.current !== null) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (tickTimerRef.current !== null) {
      window.clearInterval(tickTimerRef.current);
      tickTimerRef.current = null;
    }
  };

  const stopRecording = (reason: StopReason = "user") => {
    clearRecordTimers();
    if (reason === "discard") takeSerialRef.current += 1;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      releaseStream();
      setRecording(false);
      return;
    }
    stopReasonRef.current = reason;
    const started = startedAtRef.current ?? Date.now();
    pendingDurationMsRef.current = reason === "limit" ? RECORD_LIMIT_MS : Math.max(0, Date.now() - started);
    recorder.stop();
  };
  stopRecordingRef.current = stopRecording;

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      stopRecordingRef.current("discard");
      const target = previouslyFocused.current;
      previouslyFocused.current = null;
      window.requestAnimationFrame(() => target?.focus());
    };
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setVaultLoading(true);
    setVaultError("");
    void loadVaultChoices()
      .then((choices) => {
        if (!cancelled) setVaultTracks(choices);
      })
      .catch(() => {
        if (!cancelled) {
          setVaultTracks([]);
          setVaultError("Could not load the vault.");
        }
      })
      .finally(() => {
        if (!cancelled) setVaultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen || typeof document === "undefined") return null;

  const releasePreview = () => {
    if (!previewUrlRef.current) return;
    URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  };

  const publishVocal = (vocal: SelectedVocal | null) => {
    if (onSelectVocalRef.current) {
      onSelectVocalRef.current(vocal);
      return;
    }
    if (!vocal) {
      onSelectSourceRef.current?.(null);
      return;
    }
    onSelectSourceRef.current?.({ url: vocal.url, label: vocal.name });
  };

  const clearReadyTimer = () => {
    if (readyTimerRef.current === null) return;
    window.clearTimeout(readyTimerRef.current);
    readyTimerRef.current = null;
  };

  const clearCapturedTake = () => {
    uploadSerialRef.current += 1;
    takeSerialRef.current += 1;
    clearReadyTimer();
    savingTakeRef.current = false;
    vocalReadyRef.current = false;
    setStagingTake(false);
    setVocalReady(false);
    const applied = appliedReferenceRef.current;
    appliedReferenceRef.current = null;
    if (applied && selectedSourceUrlRef.current === applied) publishVocal(null);
    releasePreview();
    setCaptured(null);
    setShortTakeWarning("");
    setRecordError("");
    setElapsed(0);
  };

  const commitCapturedTake = async () => {
    const take = captured;
    if (!take || savingTakeRef.current || vocalReadyRef.current) return;
    const serial = uploadSerialRef.current;
    savingTakeRef.current = true;
    setStagingTake(true);
    vocalReadyRef.current = false;
    setVocalReady(false);
    setRecordError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (serial !== uploadSerialRef.current) return;
      const accessToken = sessionData.session?.access_token?.trim() ?? "";
      if (!accessToken) {
        setRecordError("Sign in to upload a vocal.");
        return;
      }
      const wavBytes = new Uint8Array(await take.blob.arrayBuffer());
      if (serial !== uploadSerialRef.current) return;
      const riff = String.fromCharCode(wavBytes[0] ?? 0, wavBytes[1] ?? 0, wavBytes[2] ?? 0, wavBytes[3] ?? 0);
      const wave = String.fromCharCode(wavBytes[8] ?? 0, wavBytes[9] ?? 0, wavBytes[10] ?? 0, wavBytes[11] ?? 0);
      if (take.blob.type !== "audio/wav" || riff !== "RIFF" || wave !== "WAVE") {
        setRecordError("Could not read this vocal take.");
        return;
      }
      const wavBlob = new Blob([wavBytes], { type: "audio/wav" });
      const form = new FormData();
      form.append("audio", wavBlob, "vocal-take.wav");
      const response = await fetch("/api/vocals/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      if (serial !== uploadSerialRef.current) return;
      let payload: { url?: unknown } = {};
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === "object") payload = parsed as { url?: unknown };
      } catch {
        payload = {};
      }
      const url = typeof payload.url === "string" ? payload.url.trim() : "";
      if (!response.ok || !isAudioVaultHttpsUrl(url)) {
        setRecordError("Could not save this vocal take.");
        return;
      }
      vocalReadyRef.current = true;
      setVocalReady(true);
      clearReadyTimer();
      readyTimerRef.current = window.setTimeout(() => {
        readyTimerRef.current = null;
        if (serial !== uploadSerialRef.current) return;
        vocalReadyRef.current = false;
        setVocalReady(false);
        appliedReferenceRef.current = url;
        publishVocal({ url, name: "Take 1", duration: take.seconds, isReady: true });
        onClose();
      }, VOCAL_READY_MS);
    } catch {
      if (serial !== uploadSerialRef.current) return;
      setRecordError("Could not save this vocal take.");
    } finally {
      savingTakeRef.current = false;
      setStagingTake(false);
    }
  };

  const acceptTake = (blob: Blob, elapsedMs: number) => {
    if (elapsedMs < MIN_RECORD_MS) {
      setShortTakeWarning(SHORT_TAKE_WARNING);
      return;
    }
    if (blob.size <= 0 || blob.type !== "audio/wav") return;
    const seconds = Math.min(30, Math.floor(elapsedMs / 1000));
    releasePreview();
    const preview = URL.createObjectURL(blob);
    previewUrlRef.current = preview;
    setCaptured({ blob, preview, seconds });
    setShortTakeWarning("");
    setRecordError("");
    vocalReadyRef.current = false;
    setVocalReady(false);
  };

  const startRecording = async () => {
    if (recording || startingRef.current || recorderRef.current?.state === "recording") return;
    takeSerialRef.current += 1;
    setRecordError("");
    setShortTakeWarning("");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordError("Recording is unavailable in this browser.");
      return;
    }
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!openRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        releaseStream();
        recorderRef.current = null;
        setRecording(false);
        const reason = stopReasonRef.current;
        const elapsedMs = pendingDurationMsRef.current;
        const recorded = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        startedAtRef.current = null;
        if (reason === "discard") return;
        if (elapsedMs < MIN_RECORD_MS) {
          setShortTakeWarning(SHORT_TAKE_WARNING);
          return;
        }
        if (recorded.size <= 0) return;
        const serial = takeSerialRef.current;
        void (async () => {
          try {
            const wav = await recordingToWavBlob(recorded);
            if (serial !== takeSerialRef.current) return;
            acceptTake(wav, elapsedMs);
          } catch {
            if (serial !== takeSerialRef.current) return;
            setRecordError("Could not read this vocal take.");
          }
        })();
      };
      recorderRef.current = recorder;
      stopReasonRef.current = "user";
      recorder.start();
      setRecording(true);
      setElapsed(0);
      const startedAt = Date.now();
      startedAtRef.current = startedAt;
      tickTimerRef.current = window.setInterval(() => {
        setElapsed(Math.min(30, Math.floor((Date.now() - startedAt) / 1000)));
      }, 200);
      stopTimerRef.current = window.setTimeout(() => {
        stopRecordingRef.current("limit");
      }, RECORD_LIMIT_MS);
    } catch {
      releaseStream();
      setRecording(false);
      setRecordError("Microphone access was denied.");
    } finally {
      startingRef.current = false;
    }
  };

  const uploadFile = async (file: File | undefined) => {
    if (!file || uploading) return;
    const extension = fileExtension(file);
    if (!extension) {
      setUploadError("Upload a .wav or .mp3 file.");
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token?.trim() ?? "";
      const userId = sessionData.session?.user?.id?.trim() ?? "";
      if (!accessToken || !userId) {
        setUploadError("Sign in to upload a vocal.");
        return;
      }
      const form = new FormData();
      form.append("audio", file);
      const response = await fetch("/api/vocals/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      let payload: { url?: unknown } = {};
      try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === "object") payload = parsed as { url?: unknown };
      } catch {
        payload = {};
      }
      const url = typeof payload.url === "string" ? payload.url.trim() : "";
      if (!response.ok || !isAudioVaultHttpsUrl(url)) {
        setUploadError("Could not save this vocal file.");
        return;
      }
      publishVocal({ url, name: file.name, duration: 0, isReady: true });
    } catch {
      setUploadError("Could not save this vocal file.");
    } finally {
      setUploading(false);
    }
  };

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    void uploadFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    void uploadFile(event.dataTransfer.files?.[0]);
  };

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vocal-studio-title"
        aria-describedby="vocal-studio-subtitle"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        className="relative z-[60] flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#141018] text-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div>
            <h2 id="vocal-studio-title" className="m-0 text-lg font-bold text-white">
              Vocal Studio
            </h2>
            <p id="vocal-studio-subtitle" className="mt-1 text-sm text-zinc-400">
              Select, record, or inject a vocal into your production
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md border-0 bg-transparent p-1 text-zinc-400 hover:text-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 pb-5 md:grid-cols-2">
          <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center gap-2 text-zinc-100">
              <Mic className="h-5 w-5 text-red-500" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider text-white">Input Voice / Mic Capture</span>
            </div>
            <h3 className="m-0 text-base font-bold">Record / Input Your Voice</h3>
            <p className="m-0 text-sm text-zinc-400">Live mic capture (15–30s take).</p>
            {captured ? (
              <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-3" aria-label="Captured Vocal">
                <p className="m-0 text-sm font-semibold text-emerald-300">✓ Voice Captured {captured.seconds}s</p>
                <TakeAudition blob={captured.blob} src={captured.preview} />
                <button
                  type="button"
                  disabled={stagingTake || vocalReady}
                  onClick={() => void commitCapturedTake()}
                  className="w-fit rounded-lg border-0 bg-emerald-500 px-4 py-2 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Lock In Vocal Take
                </button>
                {stagingTake ? (
                  <p role="status" className="m-0 text-sm font-semibold text-emerald-200">
                    Staging vocal reference...
                  </p>
                ) : null}
                {vocalReady ? (
                  <p role="status" className="m-0 text-sm font-semibold text-emerald-300">
                    ✓ Vocal Ready
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={clearCapturedTake}
                  className="w-fit rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-zinc-100"
                >
                  Re-record
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (recording) stopRecording("user");
                  else void startRecording();
                }}
                aria-label={recording ? "Stop recording" : "Record"}
                className="w-fit rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-300"
              >
                {recording ? `Stop ${elapsed}s` : "Record"}
              </button>
            )}
            {shortTakeWarning ? (
              <p role="alert" className="m-0 text-xs text-red-300">
                {shortTakeWarning}
              </p>
            ) : null}
            {recordError ? (
              <p role="alert" className="m-0 text-xs text-red-300">
                {recordError}
              </p>
            ) : null}
            {characters.length === 0 ? (
              <p className="m-0 text-sm text-zinc-500">No saved vocal profiles yet.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Saved vocal profiles">
                {characters.map((profile) => {
                  const selected = selectedCharacterId === profile.id;
                  return (
                    <button
                      key={profile.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelectCharacter(profile)}
                      className={
                        selected
                          ? "rounded-lg border border-red-500 bg-red-600/10 px-3 py-3 text-left"
                          : "rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-left hover:bg-white/10"
                      }
                    >
                      <span className="block truncate text-sm font-bold">{profile.name}</span>
                      <span className="mt-1 block text-xs text-zinc-400">{profile.timbreTag}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/40 p-4">
            <div className="flex items-center gap-2 text-rose-300">
              <AudioWaveform className="h-5 w-5" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider">Vocal Swap / Track Injection</span>
            </div>
            <h3 className="m-0 text-base font-bold">Vocal Swap / Track Inject</h3>
            <p className="m-0 text-sm text-zinc-400">Apply this voice onto an existing track or upload</p>
            <div
              role="button"
              tabIndex={uploading ? -1 : 0}
              aria-disabled={uploading}
              onClick={(event) => {
                if (uploading || event.target === fileInputRef.current) return;
                fileInputRef.current?.click();
              }}
              onKeyDown={(event) => {
                if (uploading) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!uploading) setDragOver(true);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!uploading) setDragOver(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDragOver(false);
              }}
              onDrop={handleDrop}
              className={`border border-dashed border-white/20 hover:border-red-500/40 rounded-xl p-4 text-center cursor-pointer bg-white/5 text-sm text-zinc-200${
                dragOver ? " border-red-500/40" : ""
              }${uploading ? " opacity-60" : ""}`}
            >
              {uploading ? "Uploading..." : "Click or drag & drop a .wav or .mp3 track here."}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,audio/wav,audio/mpeg"
              aria-label="Upload vocal audio"
              className="sr-only"
              onChange={handleUpload}
            />
            {uploadError ? (
              <p role="alert" className="m-0 text-xs text-red-300">
                {uploadError}
              </p>
            ) : null}
            <p className="m-0 text-sm font-semibold text-zinc-200">Or select from your Audio Vault:</p>
            {vaultLoading ? <p className="m-0 text-xs text-zinc-500">Loading vault...</p> : null}
            {vaultError ? (
              <p role="alert" className="m-0 text-xs text-red-300">
                {vaultError}
              </p>
            ) : null}
            {!vaultLoading && !vaultError && vaultTracks.length === 0 ? (
              <p className="m-0 text-sm text-zinc-500">No vaulted tracks yet.</p>
            ) : (
              <div className="flex flex-col gap-2" role="group" aria-label="Vault tracks">
                {vaultTracks.map((track) => {
                  const selected = selectedSourceUrl === track.url;
                  return (
                    <button
                      key={track.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        publishVocal({ url: track.url, name: track.title, duration: 0, isReady: true })
                      }
                      className={
                        selected
                          ? "rounded-lg border border-rose-400 bg-rose-500/10 px-3 py-2 text-left text-sm font-semibold"
                          : "rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left text-sm font-semibold hover:bg-white/10"
                      }
                    >
                      {track.title}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
