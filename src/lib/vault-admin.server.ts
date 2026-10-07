import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for the vocals routes.
 * Copied from the generate vault client so those routes stay untouched.
 */
function supabaseProjectUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || "").replace(
    /\/$/,
    "",
  );
}

export function vaultAdminClient(): SupabaseClient {
  const supabaseUrl = supabaseProjectUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

export function audioVaultPublicUrl(objectPath: string): string {
  const path = objectPath.replace(/^\/+/, "");
  return `${supabaseProjectUrl()}/storage/v1/object/public/audio-vault/${path}`;
}
