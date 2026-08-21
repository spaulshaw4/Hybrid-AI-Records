import { useEffect, useState } from "react";
import { pageHead } from "@/lib/social-meta";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

/** Only same-origin relative paths may be used as a post-reset return target. */
function safeNext(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : undefined;
}

export const Route = createFileRoute("/reset-password")({
  validateSearch: (s: Record<string, unknown>): { next?: string } => {
    const next = safeNext(s.next);
    return next ? { next } : {};
  },
  head: () =>
    pageHead({
      path: "/reset-password",
      title: "Set A New Password | Hybrid AI Records",
      description:
        "Set a new password for your Hybrid AI Records listener account and get back to your Hybrid AI Radio queue.",
      socialTitle: "Set A New Password | Hybrid AI Records",
      socialDescription: "Choose a new password for your Hybrid AI Records account.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);


  // The recovery link delivers a session (via hash) that authorises the update.
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    // The recovery link already signed them in, so send them straight to the
    // page they were trying to reach instead of back through sign-in.
    if (next && next !== "/") {
      setMessage("Password updated. Taking you back to where you left off…");
      setTimeout(() => {
        window.location.href = next;
      }, 1200);
      return;
    }
    setMessage("Password updated. Taking you back to sign in…");
    setTimeout(() => navigate({ to: "/auth", replace: true }), 1200);
  };

  const resendReset = async () => {
    setError(null);
    setMessage(null);
    if (!email) {
      setError("Enter your email address so we can send you a new reset link.");
      return;
    }
    setResendBusy(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password${
        next ? `?next=${encodeURIComponent(next)}` : ""
      }`,
    });

    setResendBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setMessage("New reset link sent. Check your inbox and open the link on this page.");
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-16">
      <div className="rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
        <h1 className="font-display text-2xl uppercase tracking-[0.14em] text-foreground">
          Set A New Password
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {ready
            ? "Choose a new password for your listener account."
            : "This page is only active after you open a password-reset link from your email."}
        </p>

        {!ready && (
          <div className="mt-5 rounded-lg border border-border-strong bg-ink/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No reset session detected.</p>
            <p className="mt-1">
              1. Make sure you clicked the link inside the reset email.<br />
              2. If the link expired or you didn't receive one, enter your email below and click “Resend reset link.”
            </p>
            <label className="mt-3 block text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Account email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="mt-1 w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <button
              type="button"
              onClick={resendReset}
              disabled={resendBusy}
              className="mt-3 w-full rounded-md border border-border-strong bg-white/5 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
            >
              {resendBusy ? "Sending…" : "Resend reset link"}
            </button>
          </div>
        )}

        <form onSubmit={submit} className="mt-6 space-y-3">
          <label className="block text-xs uppercase tracking-[0.18em] text-muted-foreground">
            New password
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="block text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Confirm password
            <input
              type="password"
              required
              minLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1 w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !ready}
            className="w-full rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Update Password"}
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-primary">{error}</p>}
        {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
      </div>
    </main>
  );
}
