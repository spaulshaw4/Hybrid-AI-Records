import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import {
  backendAnonKey,
  backendServiceRoleKey,
  backendSupabaseUrl,
  hasSupabaseAdminCredentials,
  isDevRuntime,
} from "@/lib/supabase-env.server";

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

function createSupabaseAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || backendSupabaseUrl();
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || backendServiceRoleKey();

  if (!url || !serviceRole) {
    const message =
      "Missing process.env.NEXT_PUBLIC_SUPABASE_URL or process.env.SUPABASE_SERVICE_ROLE_KEY.";
    if (isDevRuntime()) {
      console.warn(`[supabase] ${message} Mastered tracks will use local vault storage.`);
    } else {
      console.error(`[supabase] ${message}`);
    }
    throw new Error(message);
  }

  return createClient<Database>(url, serviceRole, {
    global: {
      fetch: createSupabaseFetch(serviceRole),
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

let _supabaseAdmin: SupabaseClient<Database> | undefined;

export function tryGetSupabaseAdmin(): SupabaseClient<Database> | null {
  if (!hasSupabaseAdminCredentials()) {
    if (isDevRuntime()) {
      console.warn(
        "[supabase] SUPABASE_SERVICE_ROLE_KEY is unset — using local vault storage for mastered tracks",
      );
    }
    return null;
  }
  try {
    if (!_supabaseAdmin) _supabaseAdmin = createSupabaseAdminClient();
    return _supabaseAdmin;
  } catch (error) {
    if (isDevRuntime()) {
      console.warn(
        "[supabase] admin client unavailable",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
    throw error;
  }
}

/** User-scoped client for JWT checks (anon key, not the service role). */
export function createSupabaseUserClient(accessToken: string): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || backendSupabaseUrl();
  const anon = backendAnonKey();
  if (!url || !anon) {
    throw new Error("Missing process.env.NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return createClient<Database>(url, anon, {
    global: {
      fetch: createSupabaseFetch(anon),
      ...(accessToken
        ? { headers: { Authorization: `Bearer ${accessToken}` } }
        : {}),
    },
    auth: {
      storage: undefined,
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export const supabaseAdmin = new Proxy({} as SupabaseClient<Database>, {
  get(_, prop, receiver) {
    const client = tryGetSupabaseAdmin();
    if (!client) {
      throw new Error(
        "Supabase admin client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return Reflect.get(client, prop, receiver);
  },
});
