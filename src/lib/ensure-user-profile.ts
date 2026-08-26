import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const OAUTH_NEXT_KEY = "hybrid-ai:oauth-next";

/** Persist post-login destination across the Google OAuth round-trip. */
export function stashOAuthNext(next: string | undefined) {
  if (typeof window === "undefined") return;
  if (next && next.startsWith("/") && !next.startsWith("//") && next !== "/") {
    window.sessionStorage.setItem(OAUTH_NEXT_KEY, next);
    return;
  }
  window.sessionStorage.removeItem(OAUTH_NEXT_KEY);
}

/** Consume a stashed post-login path, if any. */
export function takeOAuthNext(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.sessionStorage.getItem(OAUTH_NEXT_KEY) ?? undefined;
  window.sessionStorage.removeItem(OAUTH_NEXT_KEY);
  return value && value.startsWith("/") && !value.startsWith("//") ? value : undefined;
}

function displayNameFrom(user: User): string | null {
  const meta = user.user_metadata as Record<string, unknown> | undefined;
  for (const key of ["full_name", "name", "display_name"] as const) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const email = user.email?.trim();
  if (email?.includes("@")) return email.split("@")[0] || null;
  return null;
}

function avatarFrom(user: User): string | null {
  const meta = user.user_metadata as Record<string, unknown> | undefined;
  for (const key of ["avatar_url", "picture"] as const) {
    const value = meta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Ensures a `profiles` row exists after OAuth/email sign-in.
 * Supports both the migrated schema (`user_id`, `display_name`) and the
 * production-shaped table (`id`, `email`, `username`).
 */
export async function ensureUserProfile(user: User): Promise<void> {
  const displayName = displayNameFrom(user);
  const avatarUrl = avatarFrom(user);
  const email = user.email?.trim() || null;
  const username = email?.includes("@") ? email.split("@")[0] || null : null;

  const local = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      display_name: displayName,
      avatar_url: avatarUrl,
    },
    { onConflict: "user_id" },
  );

  if (!local.error) return;

  // Production schema uses `id` as the PK matching auth.users.id.
  const legacy = await supabase.from("profiles").upsert(
    {
      id: user.id,
      email,
      username,
    } as never,
    { onConflict: "id" },
  );

  if (legacy.error) {
    console.warn("[ensureUserProfile]", local.error.message, legacy.error.message);
  }
}
