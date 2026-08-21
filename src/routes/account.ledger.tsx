import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowDownCircle, ArrowUpCircle, Copy } from "lucide-react";

import { pageHead } from "@/lib/social-meta";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { DataLoadError } from "@/components/DataLoadError";
import { hasSupabaseSession } from "@/lib/has-session";
import { getArtistTokenLedger, type ArtistLedgerEntry } from "@/lib/artist-tokens.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/account/ledger")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/account/ledger",
      title: "Artist Token Ledger | Hybrid AI Records",
      description:
        "Every Artist Token credit, purchase and track download on your Hybrid AI Records account, with timestamps and payment references.",
      socialTitle: "Artist Token Ledger | Hybrid AI Records",
      socialDescription: "Your full Artist Token credit and spend history.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: LedgerPage,
});

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function money(cents: number | null, currency: string | null) {
  if (cents == null) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency ?? "usd").toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function label(entry: ArtistLedgerEntry) {
  if (entry.delta > 0) return entry.stripeSessionId ? "Token purchase" : "Token credit";
  return "Track download";
}

function LedgerPage() {
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(true);
  const [balance, setBalance] = useState(0);
  const [entries, setEntries] = useState<ArtistLedgerEntry[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!(await hasSupabaseSession())) {
        if (active) {
          setSignedIn(false);
          setLoading(false);
        }
        return;
      }
      try {
        const data = await getArtistTokenLedger();
        if (!active) return;
        setLoadError(false);
        setBalance(data.balance);
        setEntries(data.entries);
      } catch {
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
    } catch {
      setCopied(null);
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <PortalBreadcrumb trail={[{ label: "Account", to: "/account" }, { label: "Token ledger" }]} />

      <h1 className="mt-6 font-display text-2xl uppercase tracking-[0.14em] text-foreground">
        Artist Token Ledger
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Every $1 Artist Token you bought or spent, newest first.
      </p>

      {!signedIn ? (
        <div className="mt-6 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
          <p className="text-sm text-muted-foreground">Sign in to see your token history.</p>
          <Link
            to="/auth"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      ) : loading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading your ledger…</p>
      ) : loadError ? (
        <DataLoadError
          className="mt-6"
          message="We couldn't load your token history."
          onRetry={() => {
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : (
        <>
          <div className="mt-6 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Current balance
            </p>
            <p className="mt-1 font-display text-3xl text-foreground">
              {balance}
              <span className="ml-2 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
                {balance === 1 ? "token" : "tokens"}
              </span>
            </p>
          </div>

          {entries.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">
              No token activity yet. Buy Artist Tokens from the radio player to unlock downloads.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {entries.map((entry) => {
                const amount = money(entry.amountTotal, entry.currency);
                return (
                  <li
                    key={entry.id}
                    className="rounded-xl border border-border-strong bg-ink/50 p-4 backdrop-blur"
                  >
                    <div className="flex items-start gap-3">
                      {entry.delta > 0 ? (
                        <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                      ) : (
                        <ArrowDownCircle
                          className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">
                          {label(entry)}
                          <span className="ml-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                            {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                          </span>
                        </p>
                        {entry.note && (
                          <p className="mt-1 truncate text-xs text-muted-foreground">{entry.note}</p>
                        )}
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          {fmt(entry.createdAt)}
                          {entry.balanceAfter != null && ` · balance ${entry.balanceAfter}`}
                          {amount && ` · ${amount}`}
                        </p>
                        {entry.reference && (
                          <button
                            type="button"
                            onClick={() => copy(entry.reference as string)}
                            className="mt-2 inline-flex max-w-full items-center gap-2 rounded-md border border-border-strong bg-white/5 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground transition hover:border-primary hover:text-primary"
                          >
                            <Copy className="size-3 shrink-0" aria-hidden />
                            <span className="truncate">
                              {copied === entry.reference ? "Copied" : entry.reference}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
