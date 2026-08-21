import { supabase } from "@/integrations/supabase/client";

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

export async function clearSessionAndReauthenticate(): Promise<void> {
  if (typeof window === "undefined") return;
  const next = currentReturnPath();
  window.sessionStorage.setItem("hybrid-ai:reauth-return", next);
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("sb-") && key.endsWith("-auth-token")) {
      window.localStorage.removeItem(key);
    }
  }
  window.location.assign(`/auth?next=${encodeURIComponent(next)}`);
}
