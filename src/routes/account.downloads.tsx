import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, Music4, Search } from "lucide-react";

import { pageHead } from "@/lib/social-meta";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { DataLoadError } from "@/components/DataLoadError";
import { hasSupabaseSession } from "@/lib/has-session";
import { downloadTrack } from "@/lib/download-track";
import {
  createTrackDownloadLink,
  getArtistDownloads,
  type UnlockedDownload,
} from "@/lib/artist-tokens.functions";

export const Route = createFileRoute("/account/downloads")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/account/downloads",
      title: "Download Manager | Hybrid AI Records",
      description:
        "Every track you have permanently unlocked with Artist Tokens, ready to download again any time — no radio player needed.",
      socialTitle: "Download Manager | Hybrid AI Records",
      socialDescription: "Your permanently unlocked Hybrid AI Records tracks, in one place.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  component: DownloadsPage,
});

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function DownloadsPage() {
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(true);
  const [balance, setBalance] = useState(0);
  const [downloads, setDownloads] = useState<UnlockedDownload[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        const data = await getArtistDownloads();
        if (!active) return;
        setLoadError(false);
        setBalance(data.balance);
        setDownloads(data.downloads);
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

  const startDownload = async (item: UnlockedDownload) => {
    setBusy(item.trackId);
    setError(null);
    try {
      // Links are minted per click and expire in minutes, so a copied URL dies.
      const result = await createTrackDownloadLink({ data: { trackId: item.trackId } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await downloadTrack(result.url, result.fileName);
    } catch {
      setError("We couldn't start that download. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return downloads;
    return downloads.filter((d) =>
      `${d.title} ${d.artist} ${d.album ?? ""}`.toLowerCase().includes(q),
    );
  }, [downloads, query]);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <PortalBreadcrumb
        trail={[{ label: "Account", to: "/account" }, { label: "Download manager" }]}
      />

      <h1 className="mt-6 font-display text-2xl uppercase tracking-[0.14em] text-foreground">
        Download Manager
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Every track you own forever. Re-download as many times as you like — no token, no player.
        Each download uses a fresh secure link that expires within minutes.
      </p>

      {!signedIn ? (
        <div className="mt-6 rounded-xl border border-border-strong bg-ink/60 p-6 backdrop-blur">
          <p className="text-sm text-muted-foreground">Sign in to see your unlocked tracks.</p>
          <Link
            to="/auth"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
          >
            Sign in
          </Link>
        </div>
      ) : loading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading your library…</p>
      ) : loadError ? (
        <DataLoadError
          className="mt-6"
          message="We couldn't load your unlocked tracks."
          onRetry={() => {
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-strong bg-ink/60 p-5 backdrop-blur">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Tracks owned
              </p>
              <p className="mt-1 font-display text-3xl text-foreground">{downloads.length}</p>
            </div>
            <div className="text-right">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Artist Tokens
              </p>
              <p className="mt-1 font-display text-3xl text-foreground">{balance}</p>
              <Link
                to="/account/ledger"
                className="mt-1 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground underline-offset-4 transition hover:text-primary hover:underline"
              >
                View ledger
              </Link>
            </div>
          </div>

          {downloads.length === 0 ? (
            <div className="mt-6 rounded-xl border border-border-strong bg-ink/50 p-6 backdrop-blur">
              <p className="text-sm text-muted-foreground">
                You haven&apos;t unlocked any tracks yet. Unlock a track for $1 in the radio player
                and it lands here permanently.
              </p>
              <Link
                to="/"
                className="mt-4 inline-block rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
              >
                Browse the catalog
              </Link>
            </div>
          ) : (
            <>
              <label className="mt-5 flex items-center gap-3 rounded-lg border border-border-strong bg-ink/50 px-3 py-2.5 backdrop-blur focus-within:border-primary">
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search your tracks"
                  aria-label="Search your unlocked tracks"
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
              </label>

              {error && (
                <p className="mt-4 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-xs text-foreground">
                  {error}
                </p>
              )}

              {filtered.length === 0 ? (
                <p className="mt-6 text-sm text-muted-foreground">No tracks match “{query}”.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {filtered.map((item) => (
                    <li
                      key={item.trackId}
                      className="flex items-start gap-3 rounded-xl border border-border-strong bg-ink/50 p-4 backdrop-blur"
                    >
                      <Music4 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.artist}
                          {item.album ? ` · ${item.album}` : ""}
                        </p>
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Unlocked {fmt(item.unlockedAt)}
                        </p>
                      </div>
                      {item.available ? (
                        <button
                          type="button"
                          onClick={() => void startDownload(item)}
                          disabled={busy === item.trackId}
                          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border-strong bg-white/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground transition hover:border-primary hover:text-primary disabled:opacity-60"
                        >
                          <Download className="size-3.5" aria-hidden />
                          {busy === item.trackId ? "Preparing…" : "Download"}
                        </button>
                      ) : (
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                          Unavailable
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
