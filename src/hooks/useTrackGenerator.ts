import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import { formatValidationError } from "@/lib/validation-error";
import { notifyVaultOfNewGeneration } from "@/lib/vault-client";

const POLL_MS = 3000;
const POLL_TIMEOUT_MS = 600_000;
const POLL_TIMEOUT_MESSAGE =
  "Generation timed out after 10 minutes — no completed track in Vault.";

export type TrackGeneratorStatus = "idle" | "queued" | "running" | "completed" | "failed";

type StatusPayload = {
  session_id?: string;
  status?: string;
  error?: string | null;
  audio_filename?: string | null;
  audio_mime?: string | null;
  master_url?: string | null;
  step?: string | null;
  note?: string | null;
  detail?: unknown;
};

function whiteLabelEngineText(text: string): string {
  const sonic = "Hybrid Sonic Expressway";
  const studio = "Hybrid Studio Engine";
  return text
    .replace(/google\/lyria-3-pro/gi, sonic)
    .replace(/lyria-3-pro/gi, sonic)
    .replace(/google\s+lyria(?:\s*3(?:\s*pro)?)?/gi, sonic)
    .replace(/lyria\s*3(?:\s*pro)?/gi, sonic)
    .replace(/\blyria\b/gi, sonic)
    .replace(/minimax\/music-2\.6/gi, studio)
    .replace(/minimax\s+music(?:\s*2\.6)?/gi, studio)
    .replace(/minimax\s*2\.6/gi, studio)
    .replace(/\bmusic-2\.6\b/gi, studio)
    .replace(/\bminimax\b/gi, studio);
}

function masterPlaybackUrl(payload: StatusPayload): string | null {
  const fromMaster = (payload.master_url || "").trim();
  if (fromMaster.startsWith("http://") || fromMaster.startsWith("https://") || fromMaster.startsWith("/")) {
    return fromMaster;
  }
  if (fromMaster) return `/api/stream/${encodeURIComponent(fromMaster)}`;
  if (payload.audio_filename) return `/api/stream/${encodeURIComponent(payload.audio_filename)}`;
  return null;
}

export type TrackCreateInput = {
  prompt: string;
  genreHint?: string;
  lyrics?: string;
  durationSeconds?: number;
  bpm?: number;
  weirdness?: number;
  audioInfluence?: number;
  styleInfluence?: number;
  style?: string;
  mood?: string;
  vocalFile?: Blob | File | null;
};

function vocalTake(file: Blob | File | null | undefined): Blob | File | null {
  if (!file || file.size <= 0) return null;
  return file;
}

function bpmField(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return "86";
  return String(Math.round(bpm));
}

function durationField(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  return String(Math.round(seconds));
}

function postCreate(input: TrackCreateInput): Promise<Response> {
  const take = vocalTake(input.vocalFile);
  const form = new FormData();
  form.append("prompt", input.prompt);
  form.append("bpm", bpmField(input.bpm));
  form.append("duration", durationField(input.durationSeconds));
  if (input.lyrics != null) form.append("lyrics", input.lyrics);
  form.append("vocal_present", take ? "true" : "false");
  if (take) {
    const vocalType = take.type || "audio/wav";
    form.append("vocal_dna_file", new File([take], "vocal_dna.wav", { type: vocalType }), "vocal_dna.wav");
    form.append("vocal_file", new File([take], "ref_vocal.wav", { type: vocalType }), "ref_vocal.wav");
  }
  return fetch("/api/tracks/create", { method: "POST", body: form });
}

export function useTrackGenerator() {
  const [status, setStatus] = useState<TrackGeneratorStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollToken = useRef(0);
  const inflight = useRef(false);
  const titleRef = useRef("");

  const createJob = useMutation({
    retry: false,
    mutationFn: async (body: TrackCreateInput) => {
      const res = await postCreate(body);
      const data = await res.json().catch(() => ({}));
      return sessionFromCreateResponse(res, data);
    },
  });

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const applyStatus = useCallback(
    (payload: StatusPayload) => {
      const next = (payload.status || "").toLowerCase();
      const progress = (payload.step || payload.note || "").trim();
      if (progress) setStep(whiteLabelEngineText(progress));
      if (next === "completed") {
        inflight.current = false;
        setStatus("completed");
        setStep("completed");
        const publicUrl = masterPlaybackUrl(payload);
        if (publicUrl) {
          setAudioUrl(publicUrl);
          notifyVaultOfNewGeneration({
            id: payload.session_id,
            title: titleRef.current || "New Generation",
            status: "completed",
            masterUrl: publicUrl,
          });
        }
        stopPolling();
        return;
      }
      if (next === "failed") {
        inflight.current = false;
        setStatus("failed");
        setError(
          whiteLabelEngineText(
            formatValidationError(payload.error || payload.detail || "Generation failed."),
          ),
        );
        stopPolling();
        return;
      }
      if (next === "running" || next === "queued") {
        setStatus(next);
      }
    },
    [stopPolling],
  );

  const pollStatus = useCallback(
    async (id: string) => {
      const token = pollToken.current;
      try {
        const res = await fetch(`/api/tracks/${encodeURIComponent(id)}/status`);
        if (pollToken.current !== token) return;
        if (res.status === 404) {
          inflight.current = false;
          setStatus("failed");
          setError("Session not found.");
          stopPolling();
          return;
        }
        if (!res.ok) {
          return;
        }
        const payload = (await res.json()) as StatusPayload;
        if (pollToken.current !== token) return;
        applyStatus(payload);
      } catch {
        // Daemon may be mid-restart; keep polling until unmount or a terminal status.
      }
    },
    [applyStatus, stopPolling],
  );

  const generateTrack = useCallback(
    async (promptOrInput: string | TrackCreateInput, genreHint?: string) => {
      const input: TrackCreateInput =
        typeof promptOrInput === "string" ? { prompt: promptOrInput, genreHint } : promptOrInput;
      const trimmed = input.prompt.trim();
      const take = vocalTake(input.vocalFile);
      if (!trimmed) {
        setError("Prompt is required.");
        setStatus("failed");
        return;
      }
      if (!take && trimmed.length < 50) {
        setError("Prompt must be at least 50 characters.");
        setStatus("failed");
        return;
      }
      if (trimmed.length > 5000) {
        setError("prompt exceeds 5000 characters");
        setStatus("failed");
        return;
      }
      // Same-tick double clicks both see the old status. The ref closes that gap.
      if (inflight.current) return;
      const token = ++pollToken.current;
      inflight.current = true;
      stopPolling();
      setError(null);
      setAudioUrl(null);
      setStep(null);
      setSessionId(null);
      setStatus("queued");
      titleRef.current = trimmed.slice(0, 120);
      try {
        const id = await createJob.mutateAsync({
          ...input,
          prompt: trimmed,
          genreHint: input.genreHint ?? genreHint,
          vocalFile: take,
        });
        setSessionId(id);
        setStatus("queued");
        void pollStatus(id);
        pollRef.current = setInterval(() => {
          void pollStatus(id);
        }, POLL_MS);
        watchdogRef.current = setTimeout(() => {
          if (pollToken.current !== token) return;
          pollToken.current += 1;
          inflight.current = false;
          setStatus("failed");
          setError(POLL_TIMEOUT_MESSAGE);
          stopPolling();
        }, POLL_TIMEOUT_MS);
      } catch (err) {
        inflight.current = false;
        setStatus("failed");
        const message = err instanceof Error ? err.message : "";
        setError(
          whiteLabelEngineText(
            message && !message.toLowerCase().includes("failed to fetch")
              ? message
              : "Track create is not reachable.",
          ),
        );
      }
    },
    [createJob, pollStatus, stopPolling],
  );

  const isPending = status === "queued" || status === "running" || createJob.isPending;
  return { generateTrack, status, sessionId, error, audioUrl, step, isPending };
}
