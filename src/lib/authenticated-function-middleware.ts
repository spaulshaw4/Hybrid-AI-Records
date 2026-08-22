import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { notifySessionExpired, refreshAccessToken } from "@/lib/session-auth";

/** Adds the active app session to RPCs and retries one 401 after a silent refresh. */
export const authenticatedFunctionMiddleware = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { isDevAuthBypass } = await import("@/lib/dev-auth");
    if (isDevAuthBypass()) {
      return next({ headers: {}, fetch });
    }

    const { data } = await supabase.auth.getSession();
    const initialToken = data.session?.access_token;
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
