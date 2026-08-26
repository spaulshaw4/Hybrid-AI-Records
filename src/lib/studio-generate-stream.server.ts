/**
 * SSE generate transport — keeps the HTTP connection alive while Replicate /
 * AIMusicAPI / Fish work runs. Idle JSON server-fns send zero bytes until the
 * full 6-gate pipeline finishes, which browsers report as "Failed to fetch".
 *
 * Critical: synthesis is started OUTSIDE the ReadableStream controller so a
 * client disconnect / tab switch / reader.cancel() cannot abort vault writes.
 */

import { runWithPipelineProgressCallback } from "@/lib/pipeline-progress-als.server";
import type { StudioProgressCallback } from "@/lib/pipeline-progress";

/** Keepalive interval so proxies / browsers do not idle-close the socket. */
export const GENERATE_SSE_KEEPALIVE_MS = 15_000;

export type GenerateSseHandlers = {
  /** Runs the full studio generate; may take several minutes. */
  run: () => Promise<unknown>;
  /** Optional early signal (e.g. Gate 1 task id) before the final result. */
  onReady?: (send: (event: string, data: unknown) => void) => void;
};

/**
 * Builds a text/event-stream Response with periodic comment keepalives,
 * progress events, and a terminal `result` or `error` event.
 *
 * The pipeline promise is detached from stream cancellation: `cancel()` only
 * stops enqueueing bytes — it never aborts `handlers.run()`.
 */
export function createGenerateSseResponse(handlers: GenerateSseHandlers): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const safeEnqueue = (chunk: Uint8Array) => {
    if (closed || !streamController) return;
    try {
      streamController.enqueue(chunk);
    } catch {
      /* client gone — synthesis continues */
      closed = true;
    }
  };

  const send = (event: string, data: unknown) => {
    if (closed) return;
    safeEnqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const onProgress: StudioProgressCallback = (stage, percent, pipelineState) => {
    send("progress", {
      stage,
      percent,
      ...(typeof pipelineState === "number" ? { pipelineState } : {}),
    });
  };

  // Detach synthesis from the HTTP stream lifecycle BEFORE returning the Response.
  // Client abort must not reject this promise or skip user_vault persistence.
  const jobPromise = runWithPipelineProgressCallback(onProgress, handlers.run);
  // Prevent unhandled rejection if the stream is cancelled before `start` awaits.
  jobPromise.catch((error) => {
    console.error(
      "[GENERATE_SSE] detached job error (client may already be gone)",
      error instanceof Error ? error.message : error,
    );
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      handlers.onReady?.(send);
      send("status", { state: "started" });

      const keepalive = setInterval(() => {
        if (closed) return;
        safeEnqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
      }, GENERATE_SSE_KEEPALIVE_MS);
      keepalive.unref?.();

      void (async () => {
        try {
          const result = await jobPromise;
          send("result", result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error ?? "Generation failed");
          const cause =
            error instanceof Error && error.cause != null
              ? error.cause instanceof Error
                ? error.cause.message
                : String(error.cause)
              : undefined;
          const refunded =
            typeof error === "object" &&
            error !== null &&
            "refunded" in error &&
            Boolean((error as { refunded?: unknown }).refunded);
          console.error("[GENERATE_SSE_ERROR]", message, cause ? `| cause=${cause}` : "");
          if (error instanceof Error && error.stack) {
            console.error("[GENERATE_SSE_ERROR] stack:", error.stack.slice(0, 2500));
          }
          send("error", {
            message,
            ...(cause ? { cause } : {}),
            ...(refunded ? { refunded: true } : {}),
            gate: /Gate\s*6|mastering|FFmpeg|loudnorm/i.test(message) ? 6 : undefined,
          });
        } finally {
          clearInterval(keepalive);
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      })();
    },
    cancel() {
      // Stop writing to the socket only — do NOT abort jobPromise / vault writes.
      closed = true;
      console.info(
        "[GENERATE_SSE] client disconnected — synthesis continues until vault commit",
      );
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
