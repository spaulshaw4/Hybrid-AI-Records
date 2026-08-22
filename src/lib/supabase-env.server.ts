/**
 * Server-only Supabase credentials.
 *
 * Backend clients (generate, vault upload, Matchering finish) read:
 *   process.env.NEXT_PUBLIC_SUPABASE_URL
 *   process.env.SUPABASE_SERVICE_ROLE_KEY
 *
 * Older names stay as fallbacks so existing `.env` files keep working.
 */

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

/** Project URL for every server-side `createClient` call. */
export function backendSupabaseUrl(): string | undefined {
  return (
    fromProcess("NEXT_PUBLIC_SUPABASE_URL") ??
    fromProcess("SUPABASE_URL") ??
    fromProcess("VITE_SUPABASE_URL")
  );
}

/** Service role — required for Storage uploads that bypass RLS. */
export function backendServiceRoleKey(): string | undefined {
  return fromProcess("SUPABASE_SERVICE_ROLE_KEY") ?? fromProcess("SUPABASE_SECRET_KEY");
}

/** Anon / publishable key — JWT validation and public reads only. Never for vault writes. */
export function backendAnonKey(): string | undefined {
  return (
    fromProcess("NEXT_PUBLIC_SUPABASE_ANON_KEY") ??
    fromProcess("SUPABASE_ANON_KEY") ??
    fromProcess("SUPABASE_PUBLISHABLE_KEY") ??
    fromProcess("VITE_SUPABASE_PUBLISHABLE_KEY") ??
    fromProcess("VITE_SUPABASE_ANON_KEY")
  );
}

export function hasSupabaseAdminCredentials(): boolean {
  return Boolean(backendSupabaseUrl() && backendServiceRoleKey());
}

export function hasAnySupabaseCredentials(): boolean {
  return Boolean(backendSupabaseUrl() && (backendServiceRoleKey() || backendAnonKey()));
}

/** @deprecated Use backendSupabaseUrl — kept for existing imports. */
export function resolveSupabaseUrl(): string | undefined {
  return backendSupabaseUrl();
}

/** @deprecated Use backendAnonKey — kept for existing imports. */
export function resolveSupabaseAnonKey(): string | undefined {
  return backendAnonKey();
}

/** @deprecated Use backendServiceRoleKey — kept for existing imports. */
export function supabaseServiceRoleKey(): string | undefined {
  return backendServiceRoleKey();
}
