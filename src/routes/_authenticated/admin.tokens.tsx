import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Coins, Loader2, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  creditUserTokens,
  lookupTokenUser,
  refundUserTokens,
  type TokenAuditEntry,
  type TokenUser,
} from "@/lib/admin-tokens.functions";

export const Route = createFileRoute("/_authenticated/admin/tokens")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/tokens",
      title: "Token Credits — Hybrid AI Records",
      description:
        "Private admin tool to look up an artist by email and credit Hybrid Tokens to their balance.",
      socialTitle: "Token Credits — Hybrid AI Records",
      socialDescription: "Private admin tool for crediting Hybrid Tokens.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminTokens,
});

const QUICK_AMOUNTS = [1, 2, 5];

/** Stable per-attempt key so a retried request can never double-credit. */
function newIdempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function AdminTokens() {
  const [email, setEmail] = useState("");
  const [user, setUser] = useState<TokenUser | null>(null);
  const [history, setHistory] = useState<TokenAuditEntry[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookupFn = useServerFn(lookupTokenUser);
  const creditFn = useServerFn(creditUserTokens);
  const refundFn = useServerFn(refundUserTokens);
  const [refundAmount, setRefundAmount] = useState(1);
  const [refundReason, setRefundReason] = useState("Failed generation — engine error");
  const [refundReference, setRefundReference] = useState("");

  const lookup = useMutation({
    mutationFn: (value: string) => lookupFn({ data: { email: value } }),
    onSuccess: (res) => {
      setUser(res.user);
      setHistory(res.history);
      setNotFound(!res.user);
      setError(null);
    },
    onError: (err) => {
      setUser(null);
      setHistory([]);
      setNotFound(false);
      setError(/forbidden|unauthorized/i.test(String(err)) ? "Admin access required." : String(err));
    },
  });

  const credit = useMutation({
    mutationFn: (amount: number) =>
      creditFn({
        data: {
          userId: user!.userId,
          amount,
          reason: "Admin manual credit",
          idempotencyKey: newIdempotencyKey(`credit:${user!.userId}`),
        },
      }),
    onSuccess: (res, amount) => {
      setUser((prev) => (prev ? { ...prev, balance: res.balance } : prev));
      if (res.alreadyApplied) {
        toast.info("Already applied", {
          description: `This credit was recorded before. Balance: ${res.balance}`,
        });
      } else {
        toast.success(`Added ${amount} Hybrid Token${amount === 1 ? "" : "s"}`, {
          description: `New balance: ${res.balance}`,
        });
      }
      if (email.trim()) lookup.mutate(email.trim());
    },
    onError: (err) => toast.error("Credit failed", { description: String(err) }),
  });

  const refund = useMutation({
    mutationFn: () =>
      refundFn({
        data: {
          userId: user!.userId,
          amount: refundAmount,
          reason: refundReason.trim() || "Failed generation",
          reference: refundReference.trim() || undefined,
          // Keyed on the failed generation, so retrying the same recovery
          // (or double-clicking) can never credit the artist twice.
          idempotencyKey: refundReference.trim()
            ? `refund:${user!.userId}:${refundReference.trim()}`
            : newIdempotencyKey(`refund:${user!.userId}`),
        },
      }),
    onSuccess: (res) => {
      setUser((prev) => (prev ? { ...prev, balance: res.balance } : prev));
      if (res.alreadyApplied) {
        toast.info("Refund already applied", {
          description: `That generation was refunded before. Balance: ${res.balance}`,
        });
      } else {
        toast.success(
          `Refunded ${refundAmount} Hybrid Token${refundAmount === 1 ? "" : "s"}`,
          { description: `New balance: ${res.balance}` },
        );
      }
      if (email.trim()) lookup.mutate(email.trim());
    },
    onError: (err) => toast.error("Refund failed", { description: String(err) }),
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Admin</span>{" "}
          <span className="text-white">— Token credits</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Hybrid Token Credits
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Look up an artist by email, check their balance and top them up instantly. Every
          credit is written to the audit log.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const value = email.trim();
          if (value) lookup.mutate(value);
        }}
      >
        <label className="flex-1 min-w-[240px] text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-muted-foreground">
            Artist email
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="artist@example.com"
            className="w-full rounded-md border border-white/10 bg-ink/40 px-3 py-2 text-sm outline-none focus:border-[#e11d2e]"
          />
        </label>
        <Button type="submit" disabled={lookup.isPending || !email.trim()}>
          {lookup.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          Find artist
        </Button>
      </form>

      {error ? (
        <p className="mt-6 rounded-md border border-[#e11d2e]/40 bg-[#e11d2e]/10 px-4 py-3 text-sm text-[#ffb4bc]">
          {error}
        </p>
      ) : null}

      {notFound ? (
        <p className="mt-6 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm text-muted-foreground">
          No account found for that email.
        </p>
      ) : null}

      {user ? (
        <section className="mt-8 rounded-xl border border-white/10 bg-white/[0.03] p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">{user.email}</p>
              <p className="mt-1 flex items-center gap-2 font-display text-3xl font-bold">
                <Coins className="h-6 w-6 text-[#d4af37]" />
                {user.balance}
                <span className="text-sm font-normal text-muted-foreground">tokens</span>
              </p>
            </div>
            <div className="flex gap-2">
              {QUICK_AMOUNTS.map((amount) => (
                <Button
                  key={amount}
                  variant="secondary"
                  disabled={credit.isPending}
                  onClick={() => credit.mutate(amount)}
                >
                  {credit.isPending && credit.variables === amount ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  +{amount}
                </Button>
              ))}
            </div>
          </div>

          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <RotateCcw className="h-4 w-4" /> Refund a failed generation
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">Tokens</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={refundAmount}
                  onChange={(e) =>
                    setRefundAmount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className="w-20 rounded-md border border-white/10 bg-ink/40 px-3 py-2 text-sm outline-none focus:border-[#e11d2e]"
                />
              </label>
              <label className="min-w-[200px] flex-1 text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">Refund reason</span>
                <input
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  maxLength={300}
                  placeholder="Failed generation — engine error"
                  className="w-full rounded-md border border-white/10 bg-ink/40 px-3 py-2 text-sm outline-none focus:border-[#e11d2e]"
                />
              </label>
              <label className="min-w-[160px] text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">
                  Track / reference (optional)
                </span>
                <input
                  value={refundReference}
                  onChange={(e) => setRefundReference(e.target.value)}
                  maxLength={200}
                  placeholder="track id"
                  className="w-full rounded-md border border-white/10 bg-ink/40 px-3 py-2 text-sm outline-none focus:border-[#e11d2e]"
                />
              </label>
              <Button
                variant="secondary"
                disabled={refund.isPending || !refundReason.trim()}
                onClick={() => refund.mutate()}
              >
                {refund.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="mr-2 h-4 w-4" />
                )}
                Refund tokens
              </Button>
            </div>
          </div>

          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <ShieldCheck className="h-4 w-4" /> Recent admin credits
            </p>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No admin credits yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {history.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-4">
                    <span className="text-[#d4af37]">+{entry.amount}</span>
                    <span className="flex-1 truncate text-muted-foreground">
                      {entry.reason ?? "—"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </main>
  );
}
