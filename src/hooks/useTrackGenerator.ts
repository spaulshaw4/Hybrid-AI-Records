import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import { formatValidationError } from "@/lib/validation-error";
import { notifyVaultOfNewGeneration } from "@/lib/vault-client";

const API_BASE = (
  (typeof import.meta !== "undefined" &&
    (import.meta as ImportMeta & { env?: { VITE_HYBRID_WORKER_URL?: string } }).env
      ?.VITE_HYBRID_WORKER_URL) ||
  "http://127.0.0.1:8880"
).replace(/\/$/, "");
const POLL_MS = 3000;

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

function streamUrl(filename: string): string {
  return `${API_BASE}/api/stream/${encodeURIComponent(filename)}`;
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
  if (!file || file.size <= 64) return null;
  return file;
}

function postCreate(input: TrackCreateInput): Promise<Response> {
  const take = vocalTake(input.vocalFile);
  const form = new FormData();
  const seconds =
    input.durationSeconds == null ? "" : String(Math.round(input.durationSeconds));
  const bpm = input.bpm == null ? "" : String(Math.round(input.bpm));
  form.append("prompt", input.prompt);
  if (input.lyrics != null) form.append("lyrics", input.lyrics);
  if (input.style) form.append("style", input.style);
  if (input.mood) form.append("mood", input.mood);
  if (input.genreHint) form.append("genre_hint", input.genreHint);
  if (seconds) {
    form.append("duration", seconds);
    form.append("length", seconds);
  }
  if (bpm) {
    form.append("bpm", bpm);
    form.append("tempo", bpm);
  }
  if (input.weirdness != null) form.append("weirdness", String(input.weirdness));
  if (input.audioInfluence != null) form.append("audio_influence", String(input.audioInfluence));
  if (input.styleInfluence != null) form.append("style_influence", String(input.styleInfluence));
  form.append("vocal_present", take ? "true" : "false");
  if (take) {
    const file = new File([take], "ref_vocal.wav", { type: take.type || "audio/wav" });
    form.append("vocal_file", file, "ref_vocal.wav");
  }
  return fetch(`${API_BASE}/api/tracks/create`, { method: "POST", body: form });
}

export function useTrackGenerator() {
  const [status, setStatus] = useState<TrackGeneratorStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const applyStatus = useCallback(
    (payload: StatusPayload) => {
      const next = (payload.status || "").toLowerCase();
      const progress = (payload.step || payload.note || "").trim();
      if (progress) setStep(progress);
      if (next === "completed") {
        inflight.current = false;
        setStatus("completed");
        setStep("completed");
        const fromMaster = (payload.master_url || "").trim();
        const publicUrl = fromMaster
          ? fromMaster.startsWith("http")
            ? fromMaster
            : `${API_BASE}${fromMaster.startsWith("/") ? "" : "/"}${fromMaster}`
          : payload.audio_filename
            ? streamUrl(payload.audio_filename)
            : null;
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
        setError(formatValidationError(payload.error || payload.detail || "Generation failed."));
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
      try {
        const res = await fetch(`${API_BASE}/api/tracks/${encodeURIComponent(id)}/status`);
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
      } catch (err) {
        inflight.current = false;
        setStatus("failed");
        const message = err instanceof Error ? err.message : "";
        setError(
          message && !message.toLowerCase().includes("failed to fetch")
            ? message
            : "Headless API is not reachable at 127.0.0.1:8880.",
        );
      }
    },
    [createJob, pollStatus, stopPolling],
  );

  const isPending = status === "queued" || status === "running" || createJob.isPending;
  return { generateTrack, status, sessionId, error, audioUrl, step, isPending };
}
