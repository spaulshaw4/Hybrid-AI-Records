import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { DEV_TEST_USER, DEV_TEST_USER_UUID, isDevAuthBypass } = await import("@/lib/dev-auth");
    if (isDevAuthBypass()) {
      const { tryGetSupabaseAdmin, createSupabaseUserClient } = await import(
        "@/integrations/supabase/client.server"
      );
      let supabase = tryGetSupabaseAdmin();
      if (!supabase) {
        try {
          supabase = createSupabaseUserClient("");
        } catch (error) {
          console.warn(
            "[supabase] user client unavailable in development",
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
      }
      return next({
        context: {
          supabase,
          userId: DEV_TEST_USER_UUID,
          claims: { sub: DEV_TEST_USER_UUID, email: DEV_TEST_USER.email },
        },
      });
    }

    const { createSupabaseUserClient } = await import("@/integrations/supabase/client.server");
    const request = getRequest();

    if (!request?.headers) {
      throw new Error("Unauthorized: No request headers available");
    }

    const authHeader = request.headers.get("authorization");

    if (!authHeader) {
      throw new Error("Unauthorized: No authorization header provided");
    }

    if (!authHeader.startsWith("Bearer ")) {
      throw new Error("Unauthorized: Only Bearer tokens are supported");
    }

    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      throw new Error("Unauthorized: No token provided");
    }

    if (token.split(".").length !== 3) {
      throw new Error("Unauthorized: Invalid token");
    }

    const supabase = createSupabaseUserClient(token);

    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims) {
      throw new Error("Unauthorized: Invalid token");
    }

    if (!data.claims.sub) {
      throw new Error("Unauthorized: No user ID found in token");
    }

    return next({
      context: {
        supabase,
        userId: data.claims.sub,
        claims: data.claims,
      },
    });
  },
);
