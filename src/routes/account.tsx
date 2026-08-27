import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, KeyRound, LogOut, Mail, ShieldOff } from "lucide-react";

import { pageHead } from "@/lib/social-meta";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { LogoutButton } from "@/components/LogoutButton";
import { supabase } from "@/integrations/supabase/client";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/account")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/account",
      title: "Account Settings | Hybrid AI Records",
      description:
        "Review the sign-in methods connected to your Hybrid AI Records listener account and add a password if you only use Google.",
      socialTitle: "Account Settings | Hybrid AI Records",
      socialDescription: "See which sign-in methods are active on your account.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: AccountPage,
});

type ProviderRow = {
  id: "email" | "google";
  label: string;
  detail: string;
  enabled: boolean;
};

function AccountPage() {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [identities, setIdentities] = useState<
    Array<{ identity_id?: string; id: string; provider: string; user_id: string }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [removePassword, setRemovePassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const providers = identities.map((i) => i.provider);

  const refresh = async () => {
    const { data } = await supabase.auth.getUser();
    setEmail(data.user?.email ?? null);
    setIdentities((data.user?.identities ?? []) as never);
    if (data.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("user_id", data.user.id)
        .maybeSingle();
      setDisplayName(profile?.display_name ?? "");
    }
    setLoading(false);
  };

  const saveProfile = async () => {
    setBusy(true);
    setError(null);
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setBusy(false);
      setError("Your session expired. Please sign in again.");
      return;
    }
    const { error: profileError } = await supabase.from("profiles").upsert({
      user_id: userData.user.id,
      display_name: displayName.trim() || null,
    });
    setBusy(false);
    if (profileError) setError("Could not save your profile. Try again.");
    else setMessage("Profile saved.");
  };

  useEffect(() => {
    void refresh();
  }, []);

  const rows: ProviderRow[] = [
    {
      id: "google",
      label: "Google",
      detail: "One-tap sign-in with your Google account.",
      enabled: providers.includes("google"),
    },
    {
      id: "email",
      label: "Email & password",
      detail: "Sign in with your email address and a password you choose.",
      enabled: providers.includes("email"),
    },
  ];

  const hasPassword = rows[1]?.enabled ?? false;
  const hasGoogle = rows[0]?.enabled ?? false;

  const verifyPassword = async (password: string) => {
    if (!email) return "You're signed out.";
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    return err ? "That current password isn't right." : null;
  };

  const changePassword = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (newPassword.length < 8) {
        setError("Choose a password with at least 8 characters.");
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("The two new passwords don't match.");
        return;
      }
      const verifyError = await verifyPassword(currentPassword);
      if (verifyError) {
        setError(verifyError);
        return;
      }
      const { error: err } = await supabase.auth.updateUser({ password: newPassword });
      if (err) {
        setError(err.message);
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password updated. Use it next time you sign in with email.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const removeEmailPassword = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!hasGoogle) {
        setError("Connect Google first — otherwise you'd have no way back in.");
        return;
      }
      const verifyError = await verifyPassword(removePassword);
      if (verifyError) {
        setError(verifyError);
        return;
      }
      const identity = identities.find((i) => i.provider === "email");
      if (!identity) {
        setError("No email/password sign-in found on this account.");
        return;
      }
      const { error: err } = await supabase.auth.unlinkIdentity(identity as never);
      if (err) {
        setError(err.message);
        return;
      }
      setRemovePassword("");
      setMessage("Password sign-in removed. Continue with Google from now on.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const sendPasswordSetup = async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    setMessage(
      `Email sent to ${email}. Open the link on this device and you'll land on the page where you set your password.`,
    );
  };


  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <PortalBreadcrumb trail={[{ label: "Account" }]} />

      <h1 className="mt-6 font-display text-2xl uppercase tracking-[0.14em] text-foreground">
        Account Settings
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        These are the ways you can get into your Hybrid AI Records account.
      </p>

      {loading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading your account…</p>
      ) : !email ? (
        <div className="mt-6 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
          <p className="text-sm text-muted-foreground">
            You're signed out, so there's nothing to show yet.
          </p>
          <Link
            to="/auth"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      ) : (
        <>
          <div className="mt-6 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Signed in as</p>
            <p className="mt-1 break-all text-sm text-foreground">{email}</p>

            <div className="mt-4 space-y-2">
              <label htmlFor="account-display-name" className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Display name
              </label>
              <input
                id="account-display-name"
                value={displayName}
                maxLength={80}
                onChange={(event) => setDisplayName(event.target.value)}
                className="w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
              />
              <Button type="button" size="sm" onClick={() => void saveProfile()} disabled={busy}>
                Save profile
              </Button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                to="/account/downloads"
                className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-white/5 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary"
              >
                Download manager
              </Link>
              <Link
                to="/account/ledger"
                className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-white/5 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary"
              >
                Artist Token ledger
              </Link>
            </div>


            <ul className="mt-5 space-y-3">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start gap-3 rounded-lg border border-border-strong bg-ink/40 p-4"
                >
                  {row.enabled ? (
                    <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                  ) : (
                    <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {row.label}{" "}
                      <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {row.enabled ? "Active" : "Not set up"}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          {hasPassword && (
            <div className="mt-4 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
              <h2 className="flex items-center gap-2 font-display text-sm uppercase tracking-[0.14em] text-foreground">
                <KeyRound className="size-4 text-primary" aria-hidden />
                Change your password
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Confirm your current password first, then choose a new one.
              </p>
              <div className="mt-4 space-y-3">
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={changePassword}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
                >
                  {busy ? "Working…" : "Update password"}
                </button>
              </div>

              <div className="mt-6 border-t border-border-strong pt-5">
                <h3 className="flex items-center gap-2 font-display text-sm uppercase tracking-[0.14em] text-foreground">
                  <ShieldOff className="size-4 text-primary" aria-hidden />
                  Remove password sign-in
                </h3>
                {hasGoogle ? (
                  <>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Confirm your password to remove it. You'll keep signing in with Google.
                    </p>
                    <div className="mt-3 space-y-3">
                      <input
                        type="password"
                        autoComplete="current-password"
                        placeholder="Current password"
                        value={removePassword}
                        onChange={(e) => setRemovePassword(e.target.value)}
                        className="w-full rounded-md border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary"
                      />
                      <button
                        type="button"
                        onClick={removeEmailPassword}
                        disabled={busy}
                        className="inline-flex items-center gap-2 rounded-md border border-border-strong bg-white/5 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
                      >
                        {busy ? "Working…" : "Remove password"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Password is your only way in right now. Connect Google first before removing it.
                  </p>
                )}
              </div>

              {error && <p className="mt-4 text-sm text-primary">{error}</p>}
              {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
            </div>
          )}

          {!hasPassword && (

            <div className="mt-4 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
              <h2 className="flex items-center gap-2 font-display text-sm uppercase tracking-[0.14em] text-foreground">
                <KeyRound className="size-4 text-primary" aria-hidden />
                No password set on this account
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Your account was created with Google, so there's no password yet. Keep using
                “Continue with Google”, or add a password so you can also sign in with email:
              </p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Click “Email me a password link” below.</li>
                <li>Open the email on this device and follow the link.</li>
                <li>Choose a new password on the page that opens.</li>
              </ol>
              <button
                type="button"
                onClick={sendPasswordSetup}
                disabled={busy}
                className="mt-4 inline-flex items-center gap-2 rounded-md border border-border-strong bg-white/5 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
              >
                <Mail className="size-4" aria-hidden />
                {busy ? "Sending…" : "Email me a password link"}
              </button>
              {error && <p className="mt-3 text-sm text-primary">{error}</p>}
              {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
              <p className="mt-3 text-xs text-muted-foreground">
                Already have the link open?{" "}
                <Link to="/reset-password" className="text-primary hover:underline">
                  Go to the password page
                </Link>
                .
              </p>
            </div>
          )}
          <div className="mt-4 border border-primary/40 bg-card/70 p-6">
            <h2 className="flex items-center gap-2 font-display text-sm uppercase tracking-[0.14em] text-foreground">
              <LogOut className="size-4 text-primary" aria-hidden />
              Session controls
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Runs the static discharger: terminates auth, clears studio/vault residue on this
              device, and hard-redirects so nothing bleeds into the next session.
            </p>
            <LogoutButton className="mt-4" redirectTo="/auth">
              Sign Out &amp; Reset Session
            </LogoutButton>
          </div>
        </>
      )}
    </main>
  );
}
