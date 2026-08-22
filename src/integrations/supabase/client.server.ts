import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import {
  hasAnySupabaseCredentials,
  isDevRuntime,
  resolveSupabaseAnonKey,
  resolveSupabaseUrl,
  supabaseServiceRoleKey,
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
  const url = resolveSupabaseUrl();
  const serviceRole = supabaseServiceRoleKey();
  const anon = resolveSupabaseAnonKey();
  const key = serviceRole ?? anon;

  if (!url || !key) {
    const message =
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).";
    if (isDevRuntime()) {
      console.warn(`[supabase] ${message} Generation will use local vault storage.`);
      throw new Error(message);
    }
    console.error(`[supabase] ${message}`);
    throw new Error(message);
  }

  if (!serviceRole) {
    console.warn(
      "[supabase] SUPABASE_SERVICE_ROLE_KEY is unset — using the anon key. Vault writes may fall back to local files in development.",
    );
  }

  return createClient<Database>(url, key, {
    global: {
      fetch: createSupabaseFetch(key),
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
  if (!hasAnySupabaseCredentials()) {
    if (isDevRuntime()) {
      console.warn("[supabase] credentials missing — using local vault storage");
    }
    return null;
  }
  try {
    if (!_supabaseAdmin) _supabaseAdmin = createSupabaseAdminClient();
    return _supabaseAdmin;
  } catch (error) {
    if (isDevRuntime()) {
      console.warn(
        "[supabase] client unavailable",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
    throw error;
  }
}

export const supabaseAdmin = new Proxy({} as SupabaseClient<Database>, {
  get(_, prop, receiver) {
    const client = tryGetSupabaseAdmin();
    if (!client) {
      throw new Error("Supabase admin client is not configured.");
    }
    return Reflect.get(client, prop, receiver);
  },
});
