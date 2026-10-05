import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import { formatValidationError } from "@/lib/validation-error";

const API_BASE = (
  (typeof import.meta !== "undefined" &&
    (import.meta as ImportMeta & { env?: { VITE_HYBRID_WORKER_URL?: string } }).env
      ?.VITE_HYBRID_WORKER_URL) ||
  "http://127.0.0.1:8880"
).replace(/\/$/, "");
const POLL_MS = 2000;

export type TrackGeneratorStatus = "idle" | "queued" | "running" | "completed" | "failed";

type StatusPayload = {
  session_id?: string;
  status?: string;
  error?: string | null;
  audio_filename?: string | null;
  audio_mime?: string | null;
  detail?: unknown;
};

function streamUrl(filename: string): string {
  return `${API_BASE}/api/stream/${encodeURIComponent(filename)}`;
}

export function useTrackGenerator() {
  const [status, setStatus] = useState<TrackGeneratorStatus>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inflight = useRef(false);

  const createJob = useMutation({
    retry: false,
    mutationFn: async (body: { prompt: string; genre_hint?: string }) => {
      const res = await fetch(`${API_BASE}/api/tracks/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
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
      if (next === "completed") {
        inflight.current = false;
        setStatus("completed");
        if (payload.audio_filename) {
          setAudioUrl(streamUrl(payload.audio_filename));
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
        const res = await fetch(`${API_BASE}/api/tracks/status/${encodeURIComponent(id)}`);
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
    async (prompt: string, genreHint?: string) => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        setError("Prompt is required.");
        setStatus("failed");
        return;
      }
      if (trimmed.length < 50) {
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
      setSessionId(null);
      setStatus("queued");
      try {
        const id = await createJob.mutateAsync({
          prompt: trimmed,
          genre_hint: genreHint?.trim() || undefined,
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
  return { generateTrack, status, sessionId, error, audioUrl, isPending };
}
