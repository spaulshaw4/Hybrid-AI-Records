import { useCallback, useEffect, useRef, useState } from "react";

const API_BASE = "http://127.0.0.1:8000";
const POLL_MS = 2000;

export type TrackGeneratorStatus = "idle" | "queued" | "running" | "completed" | "failed";

type StatusPayload = {
  session_id?: string;
  status?: string;
  error?: string | null;
  audio_filename?: string | null;
  audio_mime?: string | null;
  detail?: string;
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
        setStatus("completed");
        if (payload.audio_filename) {
          setAudioUrl(streamUrl(payload.audio_filename));
        }
        stopPolling();
        return;
      }
      if (next === "failed") {
        setStatus("failed");
        setError(payload.error || payload.detail || "Generation failed.");
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
      stopPolling();
      setError(null);
      setAudioUrl(null);
      setSessionId(null);
      setStatus("queued");
      try {
        const res = await fetch(`${API_BASE}/api/tracks/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: trimmed.slice(0, 2000),
            genre_hint: genreHint?.trim() || undefined,
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as StatusPayload & {
          session_id?: string;
        };
        if (!res.ok) {
          setStatus("failed");
          setError(
            typeof payload.detail === "string" ? payload.detail : "Could not queue the track.",
          );
          return;
        }
        const id = payload.session_id;
        if (!id) {
          setStatus("failed");
          setError("Create did not return a session id.");
          return;
        }
        setSessionId(id);
        setStatus("queued");
        void pollStatus(id);
        pollRef.current = setInterval(() => {
          void pollStatus(id);
        }, POLL_MS);
      } catch {
        setStatus("failed");
        setError("Headless API is not reachable at 127.0.0.1:8000.");
      }
    },
    [pollStatus, stopPolling],
  );

  return { generateTrack, status, sessionId, error, audioUrl };
}
