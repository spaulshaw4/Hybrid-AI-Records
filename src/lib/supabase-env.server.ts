import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase-public-env";

function trim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const next = value.trim();
  return next || undefined;
}

function fromProcess(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return trim(process.env[name]);
}

export function isDevRuntime(): boolean {
  if (typeof process !== "undefined" && process.env.NODE_ENV === "development") return true;
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    /* import.meta may be unavailable in some Node test runners */
  }
  return false;
}

export function supabaseServiceRoleKey(): string | undefined {
  return fromProcess("SUPABASE_SERVICE_ROLE_KEY") ?? fromProcess("SUPABASE_SECRET_KEY");
}

export function resolveSupabaseUrl(): string | undefined {
  return supabaseUrl();
}

export function resolveSupabaseAnonKey(): string | undefined {
  return supabaseAnonKey();
}

export function hasSupabaseAdminCredentials(): boolean {
  return Boolean(resolveSupabaseUrl() && supabaseServiceRoleKey());
}

export function hasAnySupabaseCredentials(): boolean {
  return Boolean(resolveSupabaseUrl() && (supabaseServiceRoleKey() || resolveSupabaseAnonKey()));
}
