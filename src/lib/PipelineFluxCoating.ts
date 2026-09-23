/**
 * Pipeline Flux Coating — strict Zod shields between gates.
 *
 * Coats every input/output crossing In-Gate → Fluctuator → Worker → End-Gate
 * so malformed types flux away before they contaminate the queue or vault.
 *
 * Prefer the named `coat*` functions. The PipelineFluxCoating object is a thin
 * facade kept for call-site compatibility — never import it for side effects
 * from modules that FluctuatorEngine / generate-schema may pull into the same
 * Vite SSR chunk (class TDZ under circular chunk init).
 */

import { z } from "zod";
import { generateSchema } from "@/lib/generate-schema";

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

/** Module-level coat helpers — safe under Vite SSR circular chunk init. */
export function coatAndVerify<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new FluxRejectionError(result.error.issues.map((i) => i.message));
  }
  return result.data;
}

export function coatInGate(data: unknown) {
  return coatAndVerify(InGateSchema, data);
}

export function coatFluctuated(data: unknown): FluctuatedPayload {
  return coatAndVerify(FluctuatedPayloadSchema, data);
}

export function coatEndGate(data: unknown): EndGateDeliveryFlux {
  return coatAndVerify(EndGateDeliverySchema, data);
}

export function coatQueueJob(data: unknown) {
  return coatAndVerify(GenerationQueueJobFluxSchema, data);
}

/** Compatibility facade — prefer named coat* imports in hot paths. */
export const PipelineFluxCoating = {
  coatAndVerify,
  coatInGate,
  coatFluctuated,
  coatEndGate,
  coatQueueJob,
};
