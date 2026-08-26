import { createFileRoute } from "@tanstack/react-router";
import {
  parseGenerateEngineTrackInput,
  runGenerateEngineTrack,
} from "@/lib/apiframe-music.functions";
import { createGenerateSseResponse } from "@/lib/studio-generate-stream.server";
import { studioUserIdFromRequestOrDev } from "@/lib/studio-request-auth.server";

/**
 * POST /api/studio/generate-stream
 *
 * SSE generate with keepalives so long Demucs / CWALO / Gate 1 waits do not
 * surface as browser "Failed to fetch" on idle HTTP connections.
 *
 * Token burns happen server-side before the AI pipeline. Insufficient balance
 * returns HTTP 402 before the event-stream opens.
 */
export const Route = createFileRoute("/api/studio/generate-stream")({
  server: {
    handlers: {
      POST: handleGenerateStream,
      GET: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

async function handleGenerateStream({ request }: { request: Request }): Promise<Response> {
  let userId: string | null;
  try {
    userId = await studioUserIdFromRequestOrDev(request);
  } catch {
    return Response.json({ error: "Sign in to generate a track." }, { status: 401 });
  }
  if (!userId) {
    return Response.json({ error: "Sign in to generate a track." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let data: ReturnType<typeof parseGenerateEngineTrackInput>;
  try {
    data = parseGenerateEngineTrackInput(body);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid generate payload." },
      { status: 400 },
    );
  }

  const { tryGetSupabaseAdmin, createSupabaseUserClient } = await import(
    "@/integrations/supabase/client.server"
  );
  const authHeader = request.headers.get("authorization");
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const supabase = tryGetSupabaseAdmin() ?? createSupabaseUserClient(token);

  // Eager token burn so clients on every platform get a real HTTP 402 before
  // the SSE body starts — and before any upstream AI vendor call. The same
  // idempotent key is reused inside the run; failures refund automatically.
  let spendKey = "";
  try {
    const { buildGenerationIdempotencyKey } = await import("@/lib/pipeline-idempotency.server");
    const {
      authorizeAndSpendGenerationToken,
      generationTokenIdempotencyKey,
    } = await import("@/lib/generation-tokens.server");
    const lyricContent = data.instrumental ? "" : data.lyrics;
    const genre = (data.genre || data.style || data.prompt).trim();
    const runKey =
      data.idempotencyKey?.trim() ||
      buildGenerationIdempotencyKey({
        userId,
        prompt: lyricContent || genre,
        style: genre,
        lyrics: lyricContent,
        instrumental: data.instrumental,
      });
    spendKey = generationTokenIdempotencyKey(runKey);
    console.info("[generate-stream] burning token for authenticated user", {
      userId,
      spendKey,
      title: data.title || null,
    });
    await authorizeAndSpendGenerationToken({
      userId,
      supabase,
      idempotencyKey: spendKey,
      amount: 1,
      note: data.title || "Studio master generation",
    });
  } catch (error) {
    const { InsufficientTokensError } = await import("@/lib/generation-tokens.server");
    if (error instanceof InsufficientTokensError) {
      console.error("[generate-stream] token burn rejected (402)", {
        userId,
        spendKey,
        balance: error.balance,
        message: error.message,
      });
      return Response.json(
        { error: error.message, balance: error.balance, statusCode: 402 },
        { status: 402 },
      );
    }
    throw error;
  }

  return createGenerateSseResponse({
    run: async () => {
      try {
        return await runGenerateEngineTrack(data, { userId: userId!, supabase });
      } catch (error) {
        const { InsufficientTokensError, refundGenerationToken } = await import(
          "@/lib/generation-tokens.server"
        );
        if (error instanceof InsufficientTokensError) {
          throw error;
        }
        // Safety-net refund if the pipeline path did not already settle one.
        if (spendKey) {
          const reason =
            error instanceof Error ? error.message : String(error ?? "Generation failed");
          await refundGenerationToken({
            userId: userId!,
            amount: 1,
            spendIdempotencyKey: spendKey,
            note: `Refund: ${reason.slice(0, 180)}`,
          }).catch((refundErr) => {
            console.error(
              "[generate-stream] refund threw",
              refundErr instanceof Error ? refundErr.message : refundErr,
            );
          });
        }
        const {
          isEngineBusyRefundedError,
          isTransientUpstreamError,
          markEngineBusyRefunded,
        } = await import("@/lib/engine-bounce-back");
        if (isEngineBusyRefundedError(error)) throw error;
        if (isTransientUpstreamError(error)) {
          throw markEngineBusyRefunded(error);
        }
        const message =
          error instanceof Error ? error.message : String(error ?? "Generation failed");
        if (/Gate\s*6|mastering|Matchering|FFmpeg|Resemble|playable master/i.test(message)) {
          console.error("[generate-stream] Gate 6 failure detail:", message);
          if (error instanceof Error && error.cause) {
            console.error(
              "[generate-stream] Gate 6 cause:",
              error.cause instanceof Error ? error.cause.message : error.cause,
            );
          }
          if (error instanceof Error && error.stack) {
            console.error("[generate-stream] Gate 6 stack:", error.stack.slice(0, 2500));
          }
        }
        throw error;
      }
    },
  });
}
