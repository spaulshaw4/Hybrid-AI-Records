import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase-public-env";

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

const CI_SUPABASE_URL = "https://placeholder-ci.supabase.co";
const CI_SUPABASE_ANON_KEY = "placeholder-ci-anon-key";

function processEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function createSupabaseClient() {
  // Helpers already read NEXT_PUBLIC_*, SUPABASE_URL, and the publishable/anon aliases.
  const realUrl = supabaseUrl();
  const realKey = supabaseAnonKey();
  const hasRealConfig = Boolean(realUrl && realKey);
  const nodeEnv = processEnv("NODE_ENV") || import.meta.env.MODE || "";
  const ci = processEnv("CI") === "true";
  // Placeholders always resolve, so production must decide from the real env first.
  // CI and local non-production boot with placeholders. Railway without CI still throws.
  if (!hasRealConfig && nodeEnv === "production" && !ci) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  const url = realUrl || CI_SUPABASE_URL;
  const key = realKey || CI_SUPABASE_ANON_KEY;

  return createClient<Database>(url, key, {
    global: {
      fetch: createSupabaseFetch(key),
    },
    auth: {
      storage: typeof window !== "undefined" ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
