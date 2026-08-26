/**
 * SSE generate transport — keeps the HTTP connection alive while Replicate /
 * AIMusicAPI / Fish work runs. Idle JSON server-fns send zero bytes until the
 * full 6-gate pipeline finishes, which browsers report as "Failed to fetch".
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
 */
export function createGenerateSseResponse(handlers: GenerateSseHandlers): Response {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          /* stream already closed */
        }
      }, GENERATE_SSE_KEEPALIVE_MS);
      keepalive.unref?.();

      const onProgress: StudioProgressCallback = (stage, percent, pipelineState) => {
        send("progress", {
          stage,
          percent,
          ...(typeof pipelineState === "number" ? { pipelineState } : {}),
        });
      };

      try {
        handlers.onReady?.(send);
        send("status", { state: "started" });
        const result = await runWithPipelineProgressCallback(onProgress, handlers.run);
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
