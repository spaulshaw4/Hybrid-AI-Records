/**
 * User Context In-Gate — zero-trust identity envelope for consumer generation.
 *
 * TanStack equivalent of Next.js `@supabase/ssr` + cookies:
 * resolves the active user via Bearer / auth cookies + `auth.getUser()`.
 * Never falls back to DEV_TEST_USER_UUID, admin identity, or shared profiles.
 */

import {
  UnauthorizedSessionError,
  resolveStudioSession,
  type StudioSession,
} from "@/lib/studio-request-auth.server";

export type UserContextTier = "consumer" | "admin";

export type UserContextEnvelope = {
  /** Verified auth.users UUID — absolute bind for tokens + vault + queue. */
  userId: string;
  email?: string;
  /** Always false on the consumer generation path — developer bleed blocked. */
  isDeveloperOverride: boolean;
  tier: UserContextTier;
  /** Request-scoped anon client (RLS applies). */
  session: StudioSession;
};

export class InGateRejectionError extends Error {
  readonly status = 401 as const;
  readonly statusCode = 401 as const;

  constructor(message = "401 In-Gate Rejection: Unauthorized user session detected.") {
    super(message);
    this.name = "InGateRejectionError";
  }
}

/**
 * Resolves and validates the incoming user context, completely blocking
 * any developer or admin fallbacks for consumer generation requests.
 */
export class UserContextIngate {
  /**
   * Strict zero-trust resolution from an HTTP Request.
   * Never remaps failed/missing sessions onto DEV_TEST_USER_UUID.
   */
  static async resolveActiveUser(request: Request): Promise<UserContextEnvelope> {
    let session: StudioSession;
    try {
      session = await resolveStudioSession(request);
    } catch (error) {
      if (error instanceof UnauthorizedSessionError) {
        throw new InGateRejectionError();
      }
      throw new InGateRejectionError();
    }

    if (!session.userId?.trim()) {
      throw new InGateRejectionError();
    }

    // Hard lock: consumer generation path never carries a developer override.
    return {
      userId: session.userId,
      email: undefined,
      isDeveloperOverride: false,
      tier: "consumer",
      session,
    };
  }

  /**
   * When middleware already verified the JWT (server-fn context), wrap it in
   * the same envelope — still no DEV override flag.
   */
  static fromVerifiedSession(
    session: StudioSession,
    extras?: { email?: string; tier?: UserContextTier },
  ): UserContextEnvelope {
    if (!session.userId?.trim()) {
      throw new InGateRejectionError();
    }
    return {
      userId: session.userId,
      email: extras?.email,
      isDeveloperOverride: false,
      tier: extras?.tier ?? "consumer",
      session,
    };
  }

  /**
   * Bind a pre-resolved userId (requireSupabaseAuth) into a consumer envelope.
   * Rejects empty / non-uuid-looking placeholders.
   */
  static fromVerifiedUserId(
    userId: string,
    session: StudioSession,
    extras?: { email?: string },
  ): UserContextEnvelope {
    const id = userId?.trim();
    if (!id) throw new InGateRejectionError();
    // Explicitly refuse the well-known local-dev UUID as a generation identity.
    if (id === "11111111-1111-4111-8111-111111111111") {
      throw new InGateRejectionError(
        "401 In-Gate Rejection: Developer override identity is blocked on consumer generation.",
      );
    }
    return {
      userId: id,
      email: extras?.email,
      isDeveloperOverride: false,
      tier: "consumer",
      session,
    };
  }
}
