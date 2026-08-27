/**
 * Browser generate client.
 *
 * Default: async generation_queue (enqueue → poll) so shared upstream API keys
 * are drained one-at-a-time. Set VITE_GENERATE_INLINE_SSE=true for legacy SSE.
 */

import { supabase } from "@/integrations/supabase/client";
import { isDevAuthBypass } from "@/lib/dev-auth";
import {
  ENGINE_BUSY_REFUNDED_MESSAGE,
  StudioStreamDroppedError,
} from "@/lib/engine-bounce-back";

/** Soft UI deadline (matches vault poll window — 6 min). */
export const STUDIO_GENERATE_CLIENT_DEADLINE_MS = 360_000;

export const STUDIO_GENERATE_STREAM_URL = "/api/studio/generate-stream";
export const STUDIO_GENERATE_QUEUE_URL = "/api/studio/generate-queue";

const QUEUE_POLL_MS = 2_500;

function useInlineSse(): boolean {
  try {
    return import.meta.env.VITE_GENERATE_INLINE_SSE === "true";
  } catch {
    return false;
  }
}

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

async function authHeaders(accept = "application/json"): Promise<Headers> {
  const headers = new Headers({
    Accept: accept,
    "Content-Type": "application/json",
  });
  // Prefer getUser() so we never attach a stale anonymous/cached session JWT.
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error("Unauthorized session");
  }
  const { data: sessionData } = await supabase.auth.getSession();
  let token = sessionData.session?.access_token;
  if (!token || sessionData.session?.user?.id !== userData.user.id) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    token = refreshed.session?.access_token;
  }
  if (!token) throw new Error("Unauthorized session");
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function throwHttpGenerateError(response: Response, fallback: unknown): never {
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

/**
 * Enqueue → poll queue/vault until completed. Same return shape as SSE `result`.
 */
async function runQueuedStudioGenerate(
  options: StreamStudioGenerateOptions,
): Promise<Record<string, unknown>> {
  const deadlineMs = options.deadlineMs ?? STUDIO_GENERATE_CLIENT_DEADLINE_MS;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(STUDIO_GENERATE_QUEUE_URL, {
      method: "POST",
      headers: await authHeaders("application/json"),
      body: JSON.stringify(options.data),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new StudioStreamDroppedError(
      error instanceof Error ? error.message : "Generation queue failed to connect.",
    );
  }

  const enqueueBody = await response.json().catch(() => null);
  if (!response.ok) {
    throwHttpGenerateError(response, enqueueBody);
  }

  const queueId =
    enqueueBody && typeof enqueueBody === "object" && typeof (enqueueBody as { queueId?: unknown }).queueId === "string"
      ? (enqueueBody as { queueId: string }).queueId
      : "";
  const vaultId =
    enqueueBody && typeof enqueueBody === "object" && typeof (enqueueBody as { vaultId?: unknown }).vaultId === "string"
      ? (enqueueBody as { vaultId: string }).vaultId
      : null;

  if (!queueId) {
    throw new Error("Generation queued but no job id was returned.");
  }

  options.onProgress?.({ stage: "queued", percent: 2 });
  options.onTask?.({
    taskId: queueId,
    vaultId,
    status: "pending",
  });

  let pulse = 5;
  while (Date.now() - startedAt < deadlineMs) {
    if (options.signal?.aborted) throw new Error("Render canceled.");

    const statusRes = await fetch(`${STUDIO_GENERATE_QUEUE_URL}/${encodeURIComponent(queueId)}`, {
      method: "GET",
      headers: await authHeaders("application/json"),
      signal: options.signal,
    });
    const statusBody = await statusRes.json().catch(() => null);
    if (statusRes.status === 401) throw new Error("Unauthorized session");
    if (!statusRes.ok) {
      // Transient — keep polling (worker may still be finishing).
      await sleep(QUEUE_POLL_MS, options.signal);
      continue;
    }

    const status =
      statusBody && typeof statusBody === "object" && typeof (statusBody as { status?: unknown }).status === "string"
        ? (statusBody as { status: string }).status
        : "";

    if (status === "pending") {
      options.onProgress?.({ stage: "queued", percent: Math.min(12, pulse) });
    } else if (status === "processing") {
      pulse = Math.min(88, pulse + 4);
      options.onProgress?.({ stage: "composition", percent: pulse });
    } else if (status === "completed") {
      options.onProgress?.({ stage: "complete", percent: 100 });
      const result =
        statusBody && typeof statusBody === "object" && (statusBody as { result?: unknown }).result
          ? ((statusBody as { result: Record<string, unknown> }).result ?? {})
          : {};
      if (result && typeof result === "object") {
        return {
          ...result,
          queueId,
          vaultId: (result as { vaultId?: unknown }).vaultId ?? vaultId,
        };
      }
      return { queueId, vaultId, status: "completed", tokenSettled: true };
    } else if (status === "failed") {
      const message =
        statusBody && typeof statusBody === "object" && typeof (statusBody as { error?: unknown }).error === "string"
          ? (statusBody as { error: string }).error
          : ENGINE_BUSY_REFUNDED_MESSAGE;
      const err = new Error(message) as Error & { refunded?: boolean };
      err.refunded = true;
      throw err;
    }

    await sleep(QUEUE_POLL_MS, options.signal);
  }

  throw new StudioStreamDroppedError(
    "The render is still going but this connection timed out after 6 minutes.",
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Render canceled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Render canceled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs studio generate (queue by default, or legacy SSE).
 */
export async function streamStudioGenerate(
  options: StreamStudioGenerateOptions,
): Promise<Record<string, unknown>> {
  if (!useInlineSse()) {
    return runQueuedStudioGenerate(options);
  }
  return runInlineSseStudioGenerate(options);
}

async function runInlineSseStudioGenerate(
  options: StreamStudioGenerateOptions,
): Promise<Record<string, unknown>> {
  const deadlineMs = options.deadlineMs ?? STUDIO_GENERATE_CLIENT_DEADLINE_MS;
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(STUDIO_GENERATE_STREAM_URL, {
      method: "POST",
      headers: await authHeaders("text/event-stream"),
      body: JSON.stringify(options.data),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new StudioStreamDroppedError(
      error instanceof Error ? error.message : "Generation stream failed to connect.",
    );
  }

  if (!response.ok) {
    const fallback = await response.json().catch(() => null);
    throwHttpGenerateError(response, fallback);
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
    if (sawProgress || !result) {
      throw new StudioStreamDroppedError(
        error instanceof Error ? error.message : "Generation stream dropped mid-render.",
      );
    }
    throw error;
  }

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
