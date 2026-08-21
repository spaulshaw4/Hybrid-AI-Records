import { useEffect, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

/** Only same-origin relative paths may be used as a post-login return target. */
function safeNext(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

export const Route = createFileRoute("/auth")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => {
    const next = safeNext(s.next);
    return next ? { next } : {};
  },
  head: () =>
    pageHead({
      path: "/auth",
      title: "Hybrid Access | Hybrid AI Records",
      description: "Sign in to manage your tokens, save generated tracks, and access your catalog.",
      socialTitle: "Hybrid Access | Hybrid AI Records",
      socialDescription: "Sign in to manage your tokens, save generated tracks, and access your catalog.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: AuthPage,
});

/** Official four-color Google G for the sign-in button. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className="shrink-0">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpCountdown, setOtpCountdown] = useState(0);
  const [otpSending, setOtpSending] = useState(false);

  /**
   * Email links land back on this public route with the intended destination
   * preserved, so the session is hydrated before we forward the user on.
   */
  const emailReturnUrl =
    typeof window === "undefined"
      ? "/auth"
      : `${window.location.origin}/auth${next ? `?next=${encodeURIComponent(next)}` : ""}`;

  /** Where to land after sign-in — the page they originally wanted, or home. */
  const goNext = () => {
    if (next && next !== "/") {
      window.location.href = next;
      return;
    }
    navigate({ to: "/", replace: true });
  };


  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) goNext();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, next]);

  /** Turn Supabase auth errors into something a human can act on. */
  const explain = (raw: string) => {
    const m = raw.toLowerCase();
    if (m.includes("invalid login credentials")) {
      return "That email and password don't match an account. If you originally joined with Google, use “Continue with Google” — or send yourself a sign-in link below.";
    }
    if (m.includes("email not confirmed")) {
      return "Your email isn't confirmed yet. Check your inbox for the confirmation link, or send yourself a sign-in link below.";
    }
    if (m.includes("already registered")) {
      return "An account already exists for that email. Sign in instead, or send yourself a sign-in link.";
    }
    if (m.includes("over_email_send_rate_limit") || m.includes("rate limit")) {
      return "We sent a link too recently. Please wait before requesting another.";
    }
    return raw;
  };

  /** Extract retry-after seconds from GoTrue rate-limit messages. */
  const parseRateLimitSeconds = (raw: string): number => {
    const match = raw.match(/(?:after|in)\s+(\d+)\s+seconds/i);
    return match ? Math.max(1, parseInt(match[1], 10)) : 0;
  };

  useEffect(() => {
    if (otpCountdown <= 0) return;
    const t = setTimeout(() => setOtpCountdown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [otpCountdown]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === "signup") {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: emailReturnUrl },

        });
        if (err) throw err;
        if (!data.session) {
          setMessage("Check your email to confirm your account, then sign in.");
          return;
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
      goNext();
    } catch (err) {
      setError(explain(err instanceof Error ? err.message : "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  };

  /** Passwordless fallback — works even for Google-only accounts. */
  const magicLink = async () => {
    setError(null);
    setMessage(null);
    if (!email) {
      setError("Enter your email address first, then request a sign-in link.");
      return;
    }
    setOtpSending(true);
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: emailReturnUrl },
    });
    setOtpSending(false);
    if (err) {
      const seconds = parseRateLimitSeconds(err.message);
      if (seconds > 0) setOtpCountdown(seconds);
      setError(explain(err.message));
      return;
    }
    setOtpSent(true);
    setOtpCountdown(60);
    setMessage("Sign-in link sent. Open the email on this device and you'll land back here signed in.");
  };

  /** Set or reset a password (Google-only accounts can use this to add one). */
  const forgotPassword = async () => {
    setError(null);
    setMessage(null);
    if (!email) {
      setError("Enter your email address first, then request a password reset.");
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password${
        next ? `?next=${encodeURIComponent(next)}` : ""
      }`,
    });
    setBusy(false);
    if (err) {
      setError(explain(err.message));
      return;
    }
    setMessage("Password reset email sent. Follow the link to set a new password.");
  };

  const google = async () => {
    setError(null);
    // OAuth must return to this public route; goNext() then forwards to the
    // page the user originally tried to open, once the session is hydrated.
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: `${window.location.origin}/auth${
        next ? `?next=${encodeURIComponent(next)}` : ""
      }`,
    });
    if (result.error) {
      setError("Google sign-in failed. Try again.");
      return;
    }
    if (result.redirected) return;
    goNext();
  };




  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-16">
      <div className="hybrid-access-card studio-glass rounded-xl p-6">
        <h1 className="hybrid-access-title text-slab-none font-display text-2xl uppercase tracking-[0.14em] text-foreground">
          Hybrid Access
        </h1>
        <p className="hybrid-access-subtitle text-slab-none mt-2 text-sm leading-relaxed">
          Sign in to manage your tokens, save generated tracks, and access your catalog.
        </p>

        <button
          type="button"
          onClick={google}
          className="hybrid-access-google mt-6 inline-flex w-full items-center justify-center gap-2.5 rounded-md border border-white/60 bg-white/80 px-4 py-2.5 font-mono text-xs uppercase text-foreground transition hover:border-primary hover:text-primary"
        >
          <GoogleMark />
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          <span className="h-px flex-1 bg-border-strong" />
          or
          <span className="h-px flex-1 bg-border-strong" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="block text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Password
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Working…" : mode === "signin" ? "Sign In" : "Create Account"}
          </button>
        </form>

        {error && (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
            {error}
          </div>
        )}
        {message && (
          <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
            {message}
          </div>
        )}

        <div className="text-slab-none mt-5 space-y-2 text-center text-sm text-muted-foreground">
          <p>
            {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="font-medium text-foreground underline-offset-4 transition hover:text-primary hover:underline"
            >
              {mode === "signin" ? "Sign up" : "Sign in"}
            </button>
          </p>
          {mode === "signin" ? (
            <p>
              <button
                type="button"
                onClick={forgotPassword}
                disabled={busy}
                className="underline-offset-4 transition hover:text-primary hover:underline disabled:opacity-60"
              >
                Forgot password?
              </button>
            </p>
          ) : null}
          <p>
            <button
              type="button"
              onClick={magicLink}
              disabled={otpSending || otpCountdown > 0 || busy}
              className="underline-offset-4 transition hover:text-primary hover:underline disabled:opacity-60"
            >
              {otpSending
                ? "Sending sign-in link…"
                : otpCountdown > 0
                  ? otpSent
                    ? `Resend sign-in link in ${otpCountdown}s`
                    : `Request sign-in link in ${otpCountdown}s`
                  : otpSent
                    ? "Resend sign-in link"
                    : "Email me a sign-in link"}
            </button>
          </p>
        </div>

      </div>
    </main>
  );
}
