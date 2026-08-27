/**
 * API Compression & Stream Line — negotiate gzip/deflate across the API boundary.
 *
 * Wraps MasterPipelineRunner for serverless / edge handlers: inbound body
 * normalize (optional gunzip), master pipeline execution, outbound encoding
 * handshake, and light footprint measurement for stem/blueprint payloads.
 */

import { gunzipSync, gzipSync, inflateSync, deflateSync } from "node:zlib";
import type { ExecutionContext, ExecutionTier } from "@/lib/ExecutionContext";
import { ContextFactory } from "@/lib/ExecutionContext";
import {
  MasterPipelineRunner,
  type MasterPipelineInput,
  type MasterPipelineOutcome,
} from "@/lib/MasterPipelineRunner";
import type { MusicalInfluenceArchetype } from "@/lib/StyleInfluenceEnlightment";
import type { LyricSegmentInput } from "@/lib/StyleLyricEnlinement";
import type { RecordedVocalTake } from "@/lib/RecordedVoiceStructureEnlinement";

export type CompressionAlgorithm = "gzip" | "deflate" | "identity";

export type ApiCompressedResponse<T> = {
  compressionApplied: boolean;
  algorithm: CompressionAlgorithm;
  originalSizeEstimateBytes: number;
  payload: T;
};

export class ApiCompressionLine {
  /**
   * Compresses incoming pipeline requests and wraps outgoing master blueprints
   * to ensure zero-latency data flow across the API boundary.
   */
  static async handleCompressedPipelineRequest(
    ctx: ExecutionContext,
    rawRequestBody: string | Uint8Array,
    acceptEncoding: string = "gzip",
    options?: { contentEncoding?: string | null },
  ): Promise<ApiCompressedResponse<MasterPipelineOutcome>> {
    // 1. Inbound decompression (gzip / deflate client payloads → UTF-8 JSON)
    const jsonText = ApiCompressionLine.decompressInboundBody(
      rawRequestBody,
      options?.contentEncoding ?? null,
    );
    const decompressedInput = ApiCompressionLine.parseMasterPipelineInput(jsonText);

    // Gateway CTX is advisory; MasterPipelineRunner seals its own runner CTX.
    void ctx;

    // 2. Execute the Master Pipeline
    const pipelineResult = await MasterPipelineRunner.executeMasterPipeline(decompressedInput);

    // 3. Serialize and measure payload footprint
    const serialized = JSON.stringify(pipelineResult);
    const originalSize = utf8ByteLength(serialized);

    // 4. Apply outbound compression routing based on client capabilities
    const chosenAlgorithm = ApiCompressionLine.negotiateAlgorithm(acceptEncoding);

    return {
      compressionApplied: chosenAlgorithm !== "identity",
      algorithm: chosenAlgorithm,
      originalSizeEstimateBytes: originalSize,
      payload: pipelineResult,
    };
  }

  /** Prefer gzip, then deflate, else identity from Accept-Encoding. */
  static negotiateAlgorithm(acceptEncoding: string = ""): CompressionAlgorithm {
    const ae = String(acceptEncoding || "").toLowerCase();
    if (ae.includes("gzip")) return "gzip";
    if (ae.includes("deflate")) return "deflate";
    return "identity";
  }

  static decompressInboundBody(
    raw: string | Uint8Array,
    contentEncoding: string | null,
  ): string {
    const encoding = String(contentEncoding || "")
      .toLowerCase()
      .split(",")[0]
      ?.trim();

    if (!encoding || encoding === "identity" || encoding === "utf-8" || encoding === "utf8") {
      return typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    }

    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    try {
      if (encoding === "gzip" || encoding === "x-gzip") {
        return gunzipSync(bytes).toString("utf8");
      }
      if (encoding === "deflate") {
        return inflateSync(bytes).toString("utf8");
      }
    } catch {
      throw new ApiCompressionError("Failed to decompress inbound request body.", 400);
    }
    return typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  }

  static parseMasterPipelineInput(rawJson: string): MasterPipelineInput {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new ApiCompressionError("Invalid JSON body for master pipeline.", 400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ApiCompressionError("Master pipeline body must be a JSON object.", 400);
    }
    const body = parsed as Record<string, unknown>;

    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    if (!userId) {
      throw new ApiCompressionError("Missing required field: userId.", 400);
    }

    const tier = normalizeTier(body.tier);
    const genreArchetype = String(body.genreArchetype || "").trim() as MusicalInfluenceArchetype;
    if (!isGenreArchetype(genreArchetype)) {
      throw new ApiCompressionError("Missing or invalid genreArchetype.", 400);
    }

    const masterBpm = Number(body.masterBpm);
    if (!Number.isFinite(masterBpm) || masterBpm <= 0) {
      throw new ApiCompressionError("masterBpm must be a positive number.", 400);
    }

    const chaosFactor = Number(body.chaosFactor);
    if (!Number.isFinite(chaosFactor)) {
      throw new ApiCompressionError("chaosFactor must be a number.", 400);
    }

    const lyricSegments = Array.isArray(body.lyricSegments)
      ? (body.lyricSegments as LyricSegmentInput[])
      : [];
    const recordedVocalTakes = Array.isArray(body.recordedVocalTakes)
      ? (body.recordedVocalTakes as RecordedVocalTake[])
      : undefined;

    const input: MasterPipelineInput = {
      userId,
      tier,
      genreArchetype,
      masterBpm,
      lyricSegments,
      recordedVocalTakes,
      chaosFactor,
      rawPayload: body.rawPayload ?? body,
      ...(typeof body.supportedGenreHint === "string"
        ? { supportedGenreHint: body.supportedGenreHint }
        : {}),
      ...(typeof body.timeSignatureNumerator === "number"
        ? { timeSignatureNumerator: body.timeSignatureNumerator }
        : {}),
      ...(typeof body.timeSignatureDenominator === "number"
        ? { timeSignatureDenominator: body.timeSignatureDenominator }
        : {}),
      ...(typeof body.syncopationThreshold === "number"
        ? { syncopationThreshold: body.syncopationThreshold }
        : {}),
      ...(typeof body.tonicNote === "string" ? { tonicNote: body.tonicNote } : {}),
      ...(typeof body.scaleMode === "string"
        ? { scaleMode: body.scaleMode as MasterPipelineInput["scaleMode"] }
        : {}),
      ...(typeof body.workOntologyType === "string"
        ? {
            workOntologyType:
              body.workOntologyType as MasterPipelineInput["workOntologyType"],
          }
        : {}),
      ...(typeof body.listeningMode === "string"
        ? { listeningMode: body.listeningMode as MasterPipelineInput["listeningMode"] }
        : {}),
      ...(typeof body.expressiveValence === "string"
        ? {
            expressiveValence:
              body.expressiveValence as MasterPipelineInput["expressiveValence"],
          }
        : {}),
    };
    return input;
  }

  /** Encode envelope bytes for the wire when client accepted gzip/deflate. */
  static encodeOutboundBody(
    envelope: ApiCompressedResponse<MasterPipelineOutcome>,
  ): { body: Uint8Array | string; contentEncoding: CompressionAlgorithm } {
    const json = JSON.stringify(envelope);
    if (envelope.algorithm === "gzip") {
      return { body: gzipSync(json), contentEncoding: "gzip" };
    }
    if (envelope.algorithm === "deflate") {
      return { body: deflateSync(json), contentEncoding: "deflate" };
    }
    return { body: json, contentEncoding: "identity" };
  }
}

export class ApiCompressionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ApiCompressionError";
    this.statusCode = statusCode;
  }
}

/**
 * Serverless / edge POST handler: negotiate compression around MasterPipelineRunner.
 * POST /api/pipeline/master
 */
export async function handleMusicApiPost(request: Request): Promise<Response> {
  try {
    const acceptEncoding = request.headers.get("accept-encoding") || "";
    const contentEncoding = request.headers.get("content-encoding");
    const rawBody = contentEncoding
      ? new Uint8Array(await request.arrayBuffer())
      : await request.text();

    // Normalize inbound to UTF-8 JSON once (handles gzip/deflate Content-Encoding).
    const jsonText = ApiCompressionLine.decompressInboundBody(rawBody, contentEncoding);
    let peek: Record<string, unknown> = {};
    try {
      peek = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      throw new ApiCompressionError("Invalid JSON body.", 400);
    }
    const userId = typeof peek.userId === "string" ? peek.userId.trim() : "";
    if (!userId) {
      throw new ApiCompressionError("Missing required field: userId.", 400);
    }

    const ctx = ContextFactory.create(userId, normalizeTier(peek.tier), "api-gateway");
    const responseData = await ApiCompressionLine.handleCompressedPipelineRequest(
      ctx,
      jsonText,
      acceptEncoding,
      { contentEncoding: null },
    );

    const encoded = ApiCompressionLine.encodeOutboundBody(responseData);
    const pipelineStatus =
      responseData.payload && typeof responseData.payload === "object"
        ? String((responseData.payload as { status?: string }).status ?? "UNKNOWN")
        : "UNKNOWN";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Pipeline-Status": pipelineStatus,
      "X-Original-Size-Bytes": String(responseData.originalSizeEstimateBytes),
      "X-Compression-Algorithm": responseData.algorithm,
      "Cache-Control": "no-store",
    };
    if (encoded.contentEncoding !== "identity") {
      headers["Content-Encoding"] = encoded.contentEncoding;
    }

    return new Response(encoded.body, {
      status: 200,
      headers,
    });
  } catch (error: unknown) {
    if (error instanceof ApiCompressionError) {
      return Response.json(
        { error: error.message, status: "API_COMPRESSION_REJECTED" },
        { status: error.statusCode },
      );
    }
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    return Response.json(
      { error: message, status: "API_COMPRESSION_FAULT" },
      { status: 500 },
    );
  }
}

function utf8ByteLength(s: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(s, "utf8");
  }
  return new TextEncoder().encode(s).byteLength;
}

function normalizeTier(raw: unknown): ExecutionTier {
  const t = String(raw ?? "free").toLowerCase().trim();
  if (t === "enterprise" || t === "admin") return "enterprise";
  if (t === "pro" || t === "premium") return "pro";
  return "free";
}

const ARCHETYPES: readonly MusicalInfluenceArchetype[] = [
  "MODERN_TRAP_METAL_HYBRID",
  "DETROIT_INDUSTRIAL_GRIT",
  "BRITISH_POST_PUNK_TENSE",
  "SEATTLE_90S_WALL_OF_SOUND",
];

function isGenreArchetype(value: string): value is MusicalInfluenceArchetype {
  return (ARCHETYPES as readonly string[]).includes(value);
}
