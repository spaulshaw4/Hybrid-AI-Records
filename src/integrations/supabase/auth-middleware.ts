import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  resolveStudioSession,
  UnauthorizedSessionError,
} from "@/lib/studio-request-auth.server";

/**
 * Zero-trust server-fn gate (TanStack equivalent of `@supabase/ssr` + getUser).
 * Instantiates a fresh request-scoped user client from Bearer/cookies.
 * Never injects DEV UUIDs, admin clients, or shared identity fallbacks.
 */
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    type AuthClaims = { sub: string; email?: string };

    const request = getRequest();
    if (!request?.headers) {
      throw new UnauthorizedSessionError("Unauthorized session");
    }

    let session;
    try {
      session = await resolveStudioSession(request);
    } catch (error) {
      if (error instanceof UnauthorizedSessionError) throw error;
      throw new UnauthorizedSessionError("Unauthorized session");
    }

    const claims: AuthClaims = { sub: session.userId };
    return next({
      context: {
        supabase: session.supabase,
        userId: session.userId,
        claims,
      },
    });
  },
);
