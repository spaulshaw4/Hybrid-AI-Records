/**
 * Browser fetch for POST /api/studio/generate-stream (SSE).
 * No AbortSignal.timeout — only the caller's AbortSignal (user cancel) may abort.
 */

import { supabase } from "@/integrations/supabase/client";
import { isDevAuthBypass } from "@/lib/dev-auth";

/** Soft UI deadline for reading the SSE stream (matches long poll window). */
export const STUDIO_GENERATE_CLIENT_DEADLINE_MS = 25 * 60 * 1000;

export const STUDIO_GENERATE_STREAM_URL = "/api/studio/generate-stream";

export type StudioGenerateProgressEvent = {
  stage: string;
  percent: number;
  pipelineState?: number;
};

export type StreamStudioGenerateOptions = {
  data: Record<string, unknown>;
  signal?: AbortSignal;
  /** Soft deadline; does not use AbortSignal.timeout on the fetch itself. */
  deadlineMs?: number;
  onProgress?: (event: StudioGenerateProgressEvent) => void;
};

async function authHeaders(): Promise<Headers> {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

/**
 * Runs studio generate over SSE and resolves with the final `result` payload.
 */
export async function streamStudioGenerate(
  options: StreamStudioGenerateOptions,
): Promise<Record<string, unknown>> {
  const deadlineMs = options.deadlineMs ?? STUDIO_GENERATE_CLIENT_DEADLINE_MS;
  const startedAt = Date.now();

  const response = await fetch(STUDIO_GENERATE_STREAM_URL, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(options.data),
    signal: options.signal,
    // Do not set a fetch timeout — keepalives keep the socket warm.
  });

  if (!response.ok) {
    const fallback = await response.json().catch(() => null);
    const message =
      fallback && typeof fallback === "object" && "error" in fallback
        ? String((fallback as { error: unknown }).error)
        : `Generate failed (${response.status}).`;
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("Generate stream returned no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Record<string, unknown> | null = null;
  let streamError: string | null = null;

  const processBlock = (block: string) => {
    const lines = block.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      // comment keepalives (`: ...`) intentionally ignored
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "progress" && payload && typeof payload === "object") {
      const p = payload as StudioGenerateProgressEvent;
      if (typeof p.stage === "string" && typeof p.percent === "number") {
        options.onProgress?.(p);
      }
      return;
    }
    if (event === "result" && payload && typeof payload === "object") {
      result = payload as Record<string, unknown>;
      return;
    }
    if (event === "error" && payload && typeof payload === "object") {
      const p = payload as { message?: unknown; cause?: unknown };
      const message = "message" in p ? String(p.message) : "Generation failed.";
      const cause = "cause" in p && p.cause != null ? String(p.cause) : "";
      streamError = cause && !message.includes(cause) ? `${message} (${cause})` : message;
    }
  };

  while (true) {
    if (Date.now() - startedAt > deadlineMs) {
      throw new Error(
        "The render is still going but this connection timed out after 25 minutes. Use Retry to reconnect.",
      );
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const block of parts) {
      if (block.trim()) processBlock(block);
    }
    if (result || streamError) break;
  }

  // Drain remaining buffer
  if (buffer.trim()) processBlock(buffer);

  if (streamError) throw new Error(streamError);
  if (!result) {
    if (isDevAuthBypass() && options.signal?.aborted) {
      throw new Error("Render canceled.");
    }
    throw new Error("Generate stream ended without a result.");
  }
  return result;
}
