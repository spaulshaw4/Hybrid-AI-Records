/**
 * Pipeline Flux Coating — strict Zod shields between gates.
 *
 * Coats every input/output crossing In-Gate → Fluctuator → Worker → End-Gate
 * so malformed types flux away before they contaminate the queue or vault.
 */

import { z } from "zod";
import { generateSchema } from "@/lib/apiframe-music.functions";

const uuidSchema = z.string().uuid("Invalid UUID format.");

/** Accept https/http, app-relative /api paths, and local-vault scheme. */
const assetUrlSchema = z
  .string()
  .trim()
  .min(1, "Invalid audio asset URL.")
  .max(4000)
  .refine(
    (value) =>
      /^https?:\/\//i.test(value) ||
      value.startsWith("/api/") ||
      value.startsWith("local-vault:"),
    "Invalid audio asset URL.",
  );

/**
 * 1. In-Gate Flux Shield — full studio generation request (existing generateSchema).
 * Also exposes a lite surface matching prompt + optional genreHint.
 */
export const InGateSchema = generateSchema;

export const InGateLiteSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(3, "Prompt must be at least 3 characters.")
    .max(1000, "Prompt exceeds maximum length."),
  genreHint: z.string().trim().max(6000).optional(),
});

/**
 * 2. Fluctuator Flux Shield — modulated envelope before provider dispatch.
 * Temperature ceiling matches FluctuatorEngine clamp (up to 1.2 for pro prefs).
 */
export const FluctuatedPayloadSchema = z.object({
  prompt: z.string().trim().min(1),
  fluctuationNonce: z.string().trim().min(1),
  parameters: z.object({
    temperature: z.number().min(0).max(1.2),
    steps: z.number().int().positive(),
    targetUserUuid: uuidSchema,
    isolatedEnvironment: z.literal(true),
    styleInfluence: z.number().int().min(0).max(100).optional(),
    weirdness: z.number().int().min(0).max(100).optional(),
    styleWeight: z.number().min(0).max(1).optional(),
    tier: z.string().trim().min(1).max(64),
    executionEngine: z.literal("algorithmic-deterministic").optional(),
  }),
  profileSnapshot: z
    .object({
      preferences: z.record(z.string(), z.unknown()),
      tokenBalance: z.number().nullable(),
    })
    .optional(),
});

/**
 * 3. End-Gate Flux Shield — delivery payload before vault persistence.
 */
export const EndGateDeliverySchema = z.object({
  jobId: uuidSchema,
  userId: uuidSchema,
  audioUrl: assetUrlSchema,
  prompt: z.string().trim().min(1),
  providerName: z.string().trim().min(1).max(120),
  title: z.string().trim().max(200).optional(),
  style: z.string().trim().max(6000).optional(),
  vaultId: uuidSchema.nullable().optional(),
  instrumentalUrl: assetUrlSchema.nullable().optional(),
  vocalUrl: assetUrlSchema.nullable().optional(),
  rawAudioUrl: assetUrlSchema.nullable().optional(),
  providerTaskId: z.string().trim().max(200).nullable().optional(),
  spendIdempotencyKey: z.string().trim().max(200).nullable().optional(),
  correlationId: z.string().trim().max(120).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

/** Worker claim row — rejects contaminated queue rows before processing. */
export const GenerationQueueJobFluxSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  vault_id: uuidSchema.nullable().optional(),
  prompt_payload: z.unknown(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  spend_idempotency_key: z.string().trim().max(200).nullable().optional(),
  error_message: z.string().nullable().optional(),
  result: z.unknown().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  assigned_node: z.string().trim().max(120).nullable().optional(),
});

export type FluctuatedPayload = z.infer<typeof FluctuatedPayloadSchema>;
export type EndGateDeliveryFlux = z.infer<typeof EndGateDeliverySchema>;

export class FluxRejectionError extends Error {
  readonly statusCode = 400 as const;
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Flux Rejection: Schema contamination detected -> ${issues.join(", ")}`);
    this.name = "FluxRejectionError";
    this.issues = issues;
  }
}

/**
 * Universal Flux Shield Utility: cleans, validates, and coats data between gates.
 */
export class PipelineFluxCoating {
  static coatAndVerify<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new FluxRejectionError(result.error.issues.map((i) => i.message));
    }
    return result.data;
  }

  static coatInGate(data: unknown) {
    return PipelineFluxCoating.coatAndVerify(InGateSchema, data);
  }

  static coatFluctuated(data: unknown): FluctuatedPayload {
    return PipelineFluxCoating.coatAndVerify(FluctuatedPayloadSchema, data);
  }

  static coatEndGate(data: unknown): EndGateDeliveryFlux {
    return PipelineFluxCoating.coatAndVerify(EndGateDeliverySchema, data);
  }

  static coatQueueJob(data: unknown) {
    return PipelineFluxCoating.coatAndVerify(GenerationQueueJobFluxSchema, data);
  }
}
