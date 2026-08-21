import { supabase } from "@/integrations/supabase/client";

/** True when a Supabase session exists; used to skip auth-only server fns. */
export async function hasSupabaseSession(): Promise<boolean> {
  try {
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session);
  } catch {
    return false;
  }
}
