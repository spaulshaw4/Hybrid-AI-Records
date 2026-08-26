import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { supabase } from "@/integrations/supabase/client";
import { ensureUserProfile, takeOAuthNext } from "@/lib/ensure-user-profile";

/**
 * Optional OAuth landing path. Prefer `redirectTo: ${origin}/` so Google
 * never hits a missing route; this handler exists so a Supabase Redirect URL
 * of `/auth/callback` still completes instead of 404ing.
 */
export const Route = createFileRoute("/auth/callback")({
  ssr: false,
  head: () =>
    pageHead({
      path: "/auth/callback",
      title: "Signing in | Hybrid AI Records",
      description: "Completing Google sign-in.",
      noindex: true,
      image: null,
      card: "summary",
    }),
  component: AuthCallback,
});

function AuthCallback() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const finish = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
        }

        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!data.session?.user) {
          throw new Error("Sign-in did not complete. Try Continue with Google again.");
        }

        await ensureUserProfile(data.session.user);
        if (cancelled) return;

        const next = takeOAuthNext() ?? "/";
        window.location.replace(next);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Google sign-in failed.");
        }
      }
    };

    void finish();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-16">
      <p className="rounded-xl border border-border bg-ink/60 p-6 text-sm text-foreground">
        {error ? (
          <>
            Could not finish Google sign-in: {error}{" "}
            <a className="underline" href="/auth">
              Back to sign in
            </a>
          </>
        ) : (
          "Signing you in…"
        )}
      </p>
    </main>
  );
}
