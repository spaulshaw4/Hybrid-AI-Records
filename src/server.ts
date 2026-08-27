import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env" });

import "./lib/env";
import "./lib/error-capture";

// Install heavy-pipeline worker handlers (SIGTERM fail+tmp purge, orphan sweep).
void import("./lib/pipeline-worker.server")
  .then((m) => m.ensurePipelineWorkerInstalled())
  .catch(() => undefined);

// Drain generation_queue sequentially (shared upstream API key shock absorber).
void import("./lib/generation-queue-worker.server")
  .then((m) => m.ensureGenerationQueueWorkerInstalled())
  .catch(() => undefined);

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { logServerError, newErrorReference } from "./lib/server-error-log";
import { isH3SwallowedErrorBody, unwrapSsrError } from "./lib/ssr-error";

/** Pipeline contracts + Gate 6 output guards (re-exported for local orchestrator). */
export type {
  GateStage,
  GateTelemetry,
  Gate1Result,
  Gate2Result,
  Gate3Result,
  Gate4Result,
  Gate5Result,
  Gate6Result,
  PipelineResponse,
  LandingSuccessResponse,
  LandingAbortResponse,
} from "./types/pipeline";
export {
  acquireTrackLock,
  releaseTrackLock,
  writeAtomicAudioFile,
  waitForFileUnlock,
} from "./lib/track-lock.server";
export { executePipeline, PipelineAbortError, isPipelineAbortError } from "./lib/execute-pipeline.server";
export {
  runHeavyPipelineJob,
  ensurePipelineWorkerInstalled,
  HEAVY_PIPELINE_SLOTS,
  PIPELINE_WATCHDOG_MS,
  WorkerSlotBusyError,
  WorkerWatchdogError,
} from "./lib/pipeline-worker.server";
export {
  GATE_6_OUTPUT_SPECS,
  GATE_6_OUTPUT_SAMPLE_RATE,
  GATE_6_OUTPUT_CHANNELS,
} from "./lib/matchering";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  response: Response,
  request: Request,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  const reference = newErrorReference(request.url);
  // h3 console.errors the wrapped HTTPError (original stack on .cause) before
  // returning this JSON. Prefer that over a synthetic wrapper — the wrapper is
  // what Sentry was grouping as JAVASCRIPT-NEXTJS-1.
  const swallowed = unwrapSsrError(consumeLastCapturedError()) ?? new Error("Unhandled SSR failure");
  logServerError(swallowed, {
    reference,
    source: "ssr:h3-swallowed",
    request,
  });
  return new Response(renderErrorPage(reference), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env?: unknown, ctx?: unknown) {
    try {
      const pathname = new URL(request.url).pathname.replace(/\/$/, "") || "/";
      if (pathname === "/api/coproducer") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { allow: "POST" },
          });
        }
        const { POST } = await import("./app/api/coproducer/route");
        return POST(request);
      }

      if (pathname === "/api/ai/optimize-prompt") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { allow: "POST" },
          });
        }
        const { POST } = await import("./app/api/ai/optimize-prompt/route");
        return POST(request);
      }

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response, request);
    } catch (error) {
      const reference = newErrorReference(request.url);
      logServerError(error, { reference, source: "ssr:fetch", request });
      return new Response(renderErrorPage(reference), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
