import { useState, type MouseEvent } from "react";
import { Loader2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

const SIGN_IN = "Please sign in to support this artist.";

/** Stable catalog artist id from the display name. The catalog has no separate artist uuid. */
export function catalogArtistId(artist: string): string {
  return artist
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

type ArtistSupportTokenButtonProps = {
  artistId: string;
  trackId: string;
  className?: string;
  /** Header card uses the gradient chip button. Album cards keep the compact control. */
  variant?: "compact" | "header";
};

/**
 * $1 catalog support checkout. Posts artistId and trackId only.
 * The server sets buyerId from the session.
 */
export function ArtistSupportTokenButton({
  artistId,
  trackId,
  className,
  variant = "compact",
}: ArtistSupportTokenButtonProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    setError(null);
    setPending(true);
    let leaving = false;
    try {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user?.id ?? "";
      const accessToken = data.session?.access_token?.trim() ?? "";
      if (!userId || userId === "guest_user" || !accessToken) {
        setError(SIGN_IN);
        return;
      }
      const res = await fetch("/api/checkout/artist-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ artistId, trackId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (res.status === 401) {
        setError(typeof payload.error === "string" && payload.error ? payload.error : SIGN_IN);
        return;
      }
      if (typeof payload.url === "string" && payload.url) {
        leaving = true;
        window.location.href = payload.url;
        return;
      }
      const message =
        typeof payload.error === "string" && payload.error ? payload.error : "Could not start checkout.";
      setError(message);
    } catch {
      setError("Could not start checkout.");
    } finally {
      if (!leaving) setPending(false);
    }
  }

  const header = variant === "header";

  return (
    <div className={header ? `ml-auto max-w-full shrink-0 max-sm:ml-0 max-sm:basis-full ${className ?? ""}` : className}>
      <button
        type="button"
        disabled={pending}
        aria-busy={pending}
        aria-label="Support Artist · $1"
        onClick={(event) => void buy(event)}
        className={
          header
            ? "flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-red-600 to-red-500 px-5 py-2 text-sm font-bold tracking-wide text-white shadow-lg shadow-red-600/30 transition-all hover:from-red-500 hover:to-red-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:justify-start"
            : "inline-flex w-full items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white transition hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
        {header ? (
          <>
            <span>Support Artist</span>
            <span className="rounded bg-black/30 px-2 py-0.5 text-xs text-red-200">$1</span>
          </>
        ) : (
          "Support artist · $1"
        )}
      </button>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-amber-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
