import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { notifySessionExpired, refreshAccessToken } from "@/lib/session-auth";

/**
 * Client RPC middleware: attaches the verified session Bearer and retries one
 * 401 after refresh. Never skips auth headers via DEV bypass — multi-tenant
 * server handlers require a real JWT.
 */
export const authenticatedFunctionMiddleware = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    // Prefer getUser() so we never attach a stale anonymous/cached session JWT.
    const { data: userData } = await supabase.auth.getUser();
    const { data: sessionData } = await supabase.auth.getSession();
    let initialToken =
      userData.user && sessionData.session?.user?.id === userData.user.id
        ? sessionData.session.access_token
        : sessionData.session?.access_token;

    if (userData.user && (!initialToken || sessionData.session?.user?.id !== userData.user.id)) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      initialToken = refreshed.session?.access_token ?? initialToken;
    }

    const authFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const firstHeaders = new Headers(request.headers);
      if (initialToken) firstHeaders.set("Authorization", `Bearer ${initialToken}`);
      const first = await fetch(new Request(request, { headers: firstHeaders }));
      if (first.status !== 401) return first;

      const refreshedToken = await refreshAccessToken();
      if (!refreshedToken) {
        notifySessionExpired();
        return first;
      }

      const retryHeaders = new Headers(request.headers);
      retryHeaders.set("Authorization", `Bearer ${refreshedToken}`);
      const retry = await fetch(new Request(request, { headers: retryHeaders }));
      if (retry.status === 401) notifySessionExpired();
      return retry;
    };

    return next({
      headers: initialToken ? { Authorization: `Bearer ${initialToken}` } : {},
      fetch: authFetch,
    });
  },
);
