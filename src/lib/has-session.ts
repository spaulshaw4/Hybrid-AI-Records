import { supabase } from "@/integrations/supabase/client";
import { isDevAuthBypass } from "@/lib/dev-auth";

/** True when a Supabase session exists; used to skip auth-only server fns. */
export async function hasSupabaseSession(): Promise<boolean> {
  if (isDevAuthBypass()) return true;
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session);
  } catch {
    return false;
  }
}
