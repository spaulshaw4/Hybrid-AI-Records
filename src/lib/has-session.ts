import { supabase } from "@/integrations/supabase/client";

/** True when a verified Supabase user exists (`getUser()` — not a DEV fake). */
export async function hasSupabaseSession(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getUser();
    return Boolean(!error && data.user?.id);
  } catch {
    return false;
  }
}
