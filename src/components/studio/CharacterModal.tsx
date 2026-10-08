import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { AudioWaveform, Mic, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

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

interface CharacterModalProps {
  isOpen: boolean;
  onClose: () => void;
  characters: VocalCharacter[];
  selectedCharacterId: string | null;
  onSelectCharacter: (char: VocalCharacter) => void;
  onSelectSource?: (source: VocalSourceSelection) => void;
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

const RECORD_LIMIT_MS = 15_000;

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
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [takeLabel, setTakeLabel] = useState("");
  const [recordError, setRecordError] = useState("");
  const [vaultTracks, setVaultTracks] = useState<VaultChoice[]>([]);
  const [vaultError, setVaultError] = useState("");
  const [vaultLoading, setVaultLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
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

  const stopRecording = () => {
    clearRecordTimers();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseStream();
    setRecording(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocused.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      clearRecordTimers();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseStream();
      setRecording(false);
      const target = previouslyFocused.current;
      previouslyFocused.current = null;
      window.requestAnimationFrame(() => target?.focus());
    };
  }, [isOpen]);

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

  const startRecording = async () => {
    if (recording) return;
    setRecordError("");
    setTakeLabel("");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecordError("Recording is unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size > 0) setTakeLabel("Take captured");
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setElapsed(0);
      const startedAt = Date.now();
      tickTimerRef.current = window.setInterval(() => {
        setElapsed(Math.min(15, Math.floor((Date.now() - startedAt) / 1000)));
      }, 200);
      stopTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, RECORD_LIMIT_MS);
    } catch {
      releaseStream();
      setRecording(false);
      setRecordError("Microphone access was denied.");
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
      const userId = sessionData.session?.user?.id?.trim() ?? "";
      if (!userId) {
        setUploadError("Sign in to upload a vocal.");
        return;
      }
      const id = crypto.randomUUID();
      const path = `vocal-references/${userId}/${id}.${extension}`;
      const { error } = await supabase.storage.from("audio-vault").upload(path, file, {
        contentType: extension === "mp3" ? "audio/mpeg" : "audio/wav",
        upsert: false,
      });
      if (error) {
        setUploadError("Upload failed.");
        return;
      }
      const { data } = supabase.storage.from("audio-vault").getPublicUrl(path);
      const url = data.publicUrl?.trim() ?? "";
      if (!url.startsWith("https://")) {
        setUploadError("Upload failed.");
        return;
      }
      onSelectSource?.({ url, label: file.name });
    } catch {
      setUploadError("Upload failed.");
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
            <p className="m-0 text-sm text-zinc-400">
              Live mic capture (8–15s take) or select a saved vocal profile
            </p>
            <button
              type="button"
              onClick={() => {
                if (recording) stopRecording();
                else void startRecording();
              }}
              aria-label={recording ? "Stop recording" : "Record"}
              className="w-fit rounded-lg border border-red-500/40 bg-red-500/15 px-3 py-1.5 text-xs font-semibold text-red-300"
            >
              {recording ? `Stop ${elapsed}s` : "Record"}
            </button>
            {takeLabel ? <p className="m-0 text-xs text-zinc-300">{takeLabel}</p> : null}
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
                      onClick={() => onSelectSource?.({ url: track.url, label: track.title })}
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
