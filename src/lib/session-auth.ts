import { supabase } from "@/integrations/supabase/client";
import { dischargeSessionState } from "@/lib/static-charge";

export const SESSION_EXPIRED_EVENT = "hybrid-ai:session-expired";

let refreshPromise: Promise<string | null> | null = null;

export function notifySessionExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = supabase.auth
    .refreshSession()
    .then(({ data, error }) => (error ? null : data.session?.access_token ?? null))
    .catch(() => null)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export function currentReturnPath(): string {
  if (typeof window === "undefined") return "/";
  const path = `${window.location.pathname}${window.location.search}`;
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

/**
 * Discharge static session charge and force re-authentication.
 * Uses the Static Discharger so studio/vault residue cannot bleed across users.
 */
export async function clearSessionAndReauthenticate(): Promise<void> {
  if (typeof window === "undefined") return;
  const next = currentReturnPath();
  await dischargeSessionState({
    signOut: true,
    aggressive: false,
    preserveReturnPath: true,
    redirectTo: `/auth?next=${encodeURIComponent(next)}`,
  });
}
