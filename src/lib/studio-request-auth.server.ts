import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (isNewSupabaseApiKey(supabaseKey) && headers.get("Authorization") === `Bearer ${supabaseKey}`) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

/** Resolves the signed-in studio user from a Bearer token. */
export async function studioUserIdFromRequest(request: Request): Promise<string> {
  const { backendAnonKey, backendSupabaseUrl } = await import("@/lib/supabase-env.server");
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || backendSupabaseUrl();
  const SUPABASE_PUBLISHABLE_KEY = backendAnonKey();
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Unauthorized");
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) throw new Error("Unauthorized");
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token || token.split(".").length !== 3) throw new Error("Unauthorized");

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: {
      fetch: createSupabaseFetch(SUPABASE_PUBLISHABLE_KEY),
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) throw new Error("Unauthorized");
  return data.claims.sub;
}

/**
 * Vault catalog lookup: real JWT when present, otherwise the local-dev user
 * so Engine / Vault never 401s while `isDevAuthBypass()` is on.
 */
export async function studioUserIdFromRequestOrDev(request: Request): Promise<string | null> {
  try {
    return await studioUserIdFromRequest(request);
  } catch {
    const { DEV_TEST_USER_UUID, isDevAuthBypass } = await import("@/lib/dev-auth");
    if (isDevAuthBypass()) return DEV_TEST_USER_UUID;
    return null;
  }
}

