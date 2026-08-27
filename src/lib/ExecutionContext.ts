/**
 * Core Execution Context — immutable envelope threaded through every pipeline layer.
 *
 * Carries user identity, session nonce, telemetry tags, and security clearance
 * from In-Gate / Cortex Worker / Actuator without loose parameter drift.
 */

export type ExecutionTier = "free" | "pro" | "enterprise";

export type ExecutionSourceGate =
  | "in-gate"
  | "cortex-worker"
  | "actuator"
  | "core-execution-runner"
  | "plugged-circuit-runner"
  | "aligned-runner"
  | "master-pipeline-runner"
  | "api-gateway";


export type ExecutionContext = {
  readonly requestId: string;
  readonly userId: string;
  readonly sessionNonce: string;
  readonly tier: ExecutionTier;
  readonly sourceGate: ExecutionSourceGate;
  readonly timestamp: number;
  /** Optional job binding when CTX is minted from generation_queue. */
  readonly jobId?: string;
};

export class ContextRejectionError extends Error {
  readonly statusCode = 401 as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextRejectionError";
  }
}

const DEV_UUID = "11111111-1111-4111-8111-111111111111";

function newUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Deterministic-enough fallback for exotic runtimes without Web Crypto.
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function newSessionNonce(seed?: string): string {
  const rand = Math.random().toString(36).slice(2, 9);
  const base = `nonce_${Date.now()}_${rand}`;
  return seed ? `${base}_${seed.slice(0, 8)}` : base;
}

function normalizeTier(raw?: string): ExecutionTier {
  const t = String(raw ?? "free").toLowerCase().trim();
  if (t === "enterprise" || t === "admin") return "enterprise";
  if (t === "pro" || t === "premium") return "pro";
  return "free";
}

function assertValidUserId(userId: string): string {
  const id = userId?.trim() ?? "";
  if (!id || id === DEV_UUID || /dev[_-]?test/i.test(id)) {
    throw new ContextRejectionError(
      "CTX Rejection: Attempted to initialize context with invalid or developer-bypassed user ID.",
    );
  }
  return id;
}

export class ContextFactory {
  /**
   * Generates a sealed, immutable Execution Context from an incoming request or job.
   */
  static create(
    userId: string,
    tier: ExecutionTier | string = "free",
    sourceGate: ExecutionSourceGate = "in-gate",
    options?: {
      requestId?: string;
      sessionNonce?: string;
      jobId?: string;
    },
  ): ExecutionContext {
    const sealedUserId = assertValidUserId(userId);
    const ctx: ExecutionContext = {
      requestId: options?.requestId?.trim() || newUuid(),
      userId: sealedUserId,
      sessionNonce:
        options?.sessionNonce?.trim() || newSessionNonce(options?.jobId ?? sealedUserId),
      tier: normalizeTier(tier),
      sourceGate,
      timestamp: Date.now(),
      ...(options?.jobId ? { jobId: options.jobId } : {}),
    };
    return Object.freeze(ctx);
  }

  /** Mint CTX for a claimed generation_queue row. */
  static createFromQueueJob(input: {
    userId: string;
    jobId: string;
    tier?: ExecutionTier | string;
    correlationId?: string;
  }): ExecutionContext {
    return ContextFactory.create(input.userId, input.tier ?? "free", "cortex-worker", {
      jobId: input.jobId,
      requestId: input.correlationId,
      sessionNonce: newSessionNonce(input.jobId),
    });
  }

  /** Assert an existing CTX still binds the expected owner (End-Gate / provider). */
  static assertOwner(ctx: ExecutionContext, expectedUserId: string): void {
    if (!ctx?.userId || ctx.userId !== expectedUserId?.trim()) {
      throw new ContextRejectionError(
        "CTX Rejection: Execution context owner mismatch.",
      );
    }
  }
}
