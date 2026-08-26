/**
 * Browser fetch for POST /api/studio/generate-stream (SSE).
 * No AbortSignal.timeout — only the caller's AbortSignal (user cancel) may abort.
 */

import { supabase } from "@/integrations/supabase/client";
import { isDevAuthBypass } from "@/lib/dev-auth";
import {
  ENGINE_BUSY_REFUNDED_MESSAGE,
  StudioStreamDroppedError,
} from "@/lib/engine-bounce-back";

/** Soft UI deadline for reading the SSE stream (matches vault poll window — 6 min). */
export const STUDIO_GENERATE_CLIENT_DEADLINE_MS = 360_000;

export const STUDIO_GENERATE_STREAM_URL = "/api/studio/generate-stream";

export type StudioGenerateProgressEvent = {
  stage: string;
  percent: number;
  pipelineState?: number;
};

export type StudioGenerateTaskEvent = {
  taskId: string;
  vaultId?: string | null;
  status?: string;
};

export type StreamStudioGenerateOptions = {
  data: Record<string, unknown>;
  signal?: AbortSignal;
  /** Soft deadline; does not use AbortSignal.timeout on the fetch itself. */
  deadlineMs?: number;
  onProgress?: (event: StudioGenerateProgressEvent) => void;
  /** Fired as soon as Gate 1 returns a provider task id (before poll completes). */
  onTask?: (event: StudioGenerateTaskEvent) => void;
};

export { StudioStreamDroppedError };

async function authHeaders(): Promise<Headers> {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  // Prefer getUser() so we never attach a stale anonymous/cached session JWT.
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }
  const { data: sessionData } = await supabase.auth.getSession();
  let token = sessionData.session?.access_token;
  if (!token || sessionData.session?.user?.id !== userData.user.id) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    token = refreshed.session?.access_token;
  }
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

  let response: Response;
  try {
    response = await fetch(STUDIO_GENERATE_STREAM_URL, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(options.data),
      signal: options.signal,
      // Do not set a fetch timeout — keepalives keep the socket warm.
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new StudioStreamDroppedError(
      error instanceof Error ? error.message : "Generation stream failed to connect.",
    );
  }

  if (!response.ok) {
    const fallback = await response.json().catch(() => null);
    const message =
      fallback && typeof fallback === "object" && "error" in fallback
        ? String((fallback as { error: unknown }).error)
        : response.status >= 500
          ? ENGINE_BUSY_REFUNDED_MESSAGE
          : `Generate failed (${response.status}).`;
    const err = new Error(message) as Error & {
      statusCode?: number;
      balance?: number;
      refunded?: boolean;
    };
    err.statusCode = response.status;
    if (message.includes(ENGINE_BUSY_REFUNDED_MESSAGE) || response.status >= 500) {
      err.refunded = true;
    }
    if (
      fallback &&
      typeof fallback === "object" &&
      "balance" in fallback &&
      typeof (fallback as { balance: unknown }).balance === "number"
    ) {
      err.balance = (fallback as { balance: number }).balance;
    }
    throw err;
  }

  if (!response.body) {
    throw new StudioStreamDroppedError("Generate stream returned no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Record<string, unknown> | null = null;
  let streamError: string | null = null;
  let sawProgress = false;

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
      sawProgress = true;
      const p = payload as StudioGenerateProgressEvent;
      if (typeof p.stage === "string" && typeof p.percent === "number") {
        options.onProgress?.(p);
      }
      return;
    }
    if (event === "task" && payload && typeof payload === "object") {
      sawProgress = true;
      const p = payload as { taskId?: unknown; vaultId?: unknown; status?: unknown };
      if (typeof p.taskId === "string" && p.taskId.trim()) {
        options.onTask?.({
          taskId: p.taskId.trim(),
          vaultId: typeof p.vaultId === "string" ? p.vaultId : null,
          status: typeof p.status === "string" ? p.status : undefined,
        });
      }
      return;
    }
    if (event === "result" && payload && typeof payload === "object") {
      result = payload as Record<string, unknown>;
      return;
    }
    if (event === "error" && payload && typeof payload === "object") {
      const p = payload as { message?: unknown; cause?: unknown; refunded?: unknown };
      const message = "message" in p ? String(p.message) : "Generation failed.";
      const cause = "cause" in p && p.cause != null ? String(p.cause) : "";
      streamError = cause && !message.includes(cause) ? `${message} (${cause})` : message;
      if (p.refunded === true && !streamError.includes(ENGINE_BUSY_REFUNDED_MESSAGE)) {
        streamError = ENGINE_BUSY_REFUNDED_MESSAGE;
      }
    }
  };

  try {
    while (true) {
      if (Date.now() - startedAt > deadlineMs) {
        throw new StudioStreamDroppedError(
          "The render is still going but this connection timed out after 6 minutes.",
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
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof StudioStreamDroppedError) throw error;
    // Mid-render drop (common on mobile Safari) → vault short-poll failover.
    if (sawProgress || !result) {
      throw new StudioStreamDroppedError(
        error instanceof Error ? error.message : "Generation stream dropped mid-render.",
      );
    }
    throw error;
  }

  // Drain remaining buffer
  if (buffer.trim()) processBlock(buffer);

  if (streamError) {
    const err = new Error(streamError) as Error & { refunded?: boolean };
    if (streamError.includes(ENGINE_BUSY_REFUNDED_MESSAGE)) err.refunded = true;
    throw err;
  }
  if (!result) {
    if (isDevAuthBypass() && options.signal?.aborted) {
      throw new Error("Render canceled.");
    }
    throw new StudioStreamDroppedError("Generate stream ended without a result.");
  }
  return result;
}
