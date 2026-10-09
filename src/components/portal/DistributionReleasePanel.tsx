import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type AudioSource = "vault" | "upload";
type RefillTier = "d5" | "d10" | "d25";

type MasteredTrack = {
  id: string;
  title: string;
};

const REFILL_PACKS: Array<{ tier: RefillTier; label: string; price: string }> = [
  { tier: "d5", label: "5 D-Token", price: "$5" },
  { tier: "d10", label: "10 D-Token", price: "$10" },
  { tier: "d25", label: "25 D-Token", price: "$25" },
];

function safeMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text || text.length > 240 || text.includes("\n") || /bearer|api[_-]?key|secret|stack/i.test(text)) {
    return fallback;
  }
  return text;
}

export function DistributionReleasePanel() {
  const [source, setSource] = useState<AudioSource>("vault");
  const [tracks, setTracks] = useState<MasteredTrack[]>([]);
  const [tracksNote, setTracksNote] = useState("Your mastered tracks");
  const [vaultTrackId, setVaultTrackId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [confirmRights, setConfirmRights] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [refillOpen, setRefillOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refillTier, setRefillTier] = useState<RefillTier | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token?.trim() ?? "";
      const userId = data.session?.user?.id ?? "";
      if (!accessToken || !userId) {
        if (!cancelled) {
          setTracks([]);
          setTracksNote("Sign in to load your mastered tracks.");
          setBalance(null);
        }
        return;
      }
      const headers = { Authorization: `Bearer ${accessToken}` };
      const [vaultRes, balanceRes] = await Promise.all([
        fetch("/api/vault", { headers }),
        fetch("/api/user/balance", { headers }),
      ]);
      if (cancelled) return;
      if (balanceRes.ok) {
        const payload = (await balanceRes.json().catch(() => ({}))) as { balance?: unknown };
        setBalance(typeof payload.balance === "number" ? payload.balance : 0);
      }
      if (!vaultRes.ok) {
        setTracksNote("Your mastered tracks could not be loaded.");
        return;
      }
      const payload = (await vaultRes.json().catch(() => ({}))) as {
        tracks?: Array<{ id?: unknown; title?: unknown; wav_url?: unknown }>;
      };
      const rows = (payload.tracks ?? [])
        .filter((row) => typeof row.id === "string" && row.id && typeof row.wav_url === "string" && row.wav_url.trim())
        .map((row) => ({
          id: row.id as string,
          title: typeof row.title === "string" && row.title.trim() ? row.title : "Untitled master",
        }));
      setTracks(rows);
      setTracksNote(rows.length ? "Your mastered tracks" : "No mastered tracks yet. Upload a WAV instead.");
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function sessionToken(): Promise<string> {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id ?? "";
    const accessToken = data.session?.access_token?.trim() ?? "";
    if (!userId || userId === "guest_user" || !accessToken) {
      window.location.href = "/auth?next=/portal";
      return "";
    }
    return accessToken;
  }

  async function startRefill(tier: RefillTier) {
    const accessToken = await sessionToken();
    if (!accessToken) return;
    setRefillTier(tier);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ tier }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (payload.url) {
        window.location.href = payload.url;
        return;
      }
      setError(safeMessage(payload.error, "Unable to start checkout."));
      setRefillTier(null);
    } catch {
      setError("Unable to start checkout.");
      setRefillTier(null);
    }
  }

  async function submitRelease(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (source === "vault" && !vaultTrackId) {
      setError("Select a mastered track.");
      return;
    }
    if (source === "upload") {
      const name = file?.name.toLowerCase() ?? "";
      if (!file || !name.endsWith(".wav")) {
        setError("Upload a finished WAV.");
        return;
      }
    }
    const accessToken = await sessionToken();
    if (!accessToken) return;

    const form = new FormData();
    form.set("title", title.trim());
    form.set("artist", artist.trim());
    form.set("source", source);
    form.set("acceptTerms", acceptTerms ? "true" : "false");
    form.set("confirmRights", confirmRights ? "true" : "false");
    if (source === "vault") form.set("vaultTrackId", vaultTrackId);
    if (source === "upload" && file) form.set("audio", file);

    setBusy(true);
    try {
      const res = await fetch("/api/distribute/too-lost", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; balance?: number };
      if (!res.ok) {
        setError(safeMessage(payload.error, "Too Lost could not accept this release. Nothing was charged."));
        return;
      }
      if (typeof payload.balance === "number") setBalance(payload.balance);
      setMessage("Release sent to Too Lost. 1 D-Token was charged.");
    } catch {
      setError("Too Lost could not accept this release. Nothing was charged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 border-t border-white/10 pt-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {balance === null ? "1 D-Token per release" : `Balance: ${balance} D-Token${balance === 1 ? "" : "s"}`}
        </p>
        <button
          type="button"
          onClick={() => setRefillOpen(true)}
          className="inline-flex items-center justify-center border border-white/15 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-white/80 transition-colors hover:border-white/40 hover:text-white"
        >
          Refill D-Tokens
        </button>
      </div>

      <form className="mt-6 space-y-5" onSubmit={(event) => void submitRelease(event)}>
        <fieldset className="space-y-3">
          <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Audio
          </legend>
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="radio"
              name="audio-source"
              value="vault"
              checked={source === "vault"}
              onChange={() => setSource("vault")}
            />
            Select Mastered Track
          </label>
          {source === "vault" && (
            <label className="block text-sm text-white/80">
              <span className="mb-1 block text-xs text-muted-foreground">{tracksNote}</span>
              <select
                aria-label="Your mastered tracks"
                value={vaultTrackId}
                onChange={(event) => setVaultTrackId(event.target.value)}
                className="w-full border border-white/10 bg-black/40 px-3 py-3 text-sm text-white"
              >
                <option value="">Select a mastered track</option>
                {tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input
              type="radio"
              name="audio-source"
              value="upload"
              checked={source === "upload"}
              onChange={() => setSource("upload")}
            />
            Upload External WAV
          </label>
          {source === "upload" && (
            <input
              type="file"
              accept=".wav,audio/wav,audio/wave,audio/x-wav"
              aria-label="Upload external WAV"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-white/80 file:mr-3 file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-white"
            />
          )}
        </fieldset>

        <label className="block text-sm text-white/80">
          Release title
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="mt-1 w-full border border-white/10 bg-black/40 px-3 py-3 text-sm text-white"
          />
        </label>
        <label className="block text-sm text-white/80">
          Primary artist
          <input
            required
            value={artist}
            onChange={(event) => setArtist(event.target.value)}
            className="mt-1 w-full border border-white/10 bg-black/40 px-3 py-3 text-sm text-white"
          />
        </label>
        <label className="flex items-start gap-2 text-sm text-white/80">
          <input type="checkbox" checked={acceptTerms} onChange={(event) => setAcceptTerms(event.target.checked)} />
          I accept the distribution terms.
        </label>
        <label className="flex items-start gap-2 text-sm text-white/80">
          <input
            type="checkbox"
            checked={confirmRights}
            onChange={(event) => setConfirmRights(event.target.checked)}
          />
          I confirm I have the rights to this master.
        </label>
        {error && (
          <p role="alert" className="text-sm text-[#e11d2e]">
            {error}
          </p>
        )}
        {message && <p className="text-sm text-emerald-400">{message}</p>}
        <button
          type="submit"
          disabled={busy || !acceptTerms || !confirmRights}
          className="inline-flex w-full items-center justify-center bg-[#e11d2e] px-8 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a] disabled:opacity-60 md:w-auto"
        >
          {busy ? "Sending…" : "Review & Submit"}
        </button>
      </form>

      {refillOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => {
            if (!refillTier) setRefillOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Refill D-Tokens"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md border border-white/10 bg-[#130b14] p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-display text-xl text-white">Refill D-Tokens</h3>
              <button
                type="button"
                aria-label="Close refill"
                disabled={refillTier !== null}
                onClick={() => setRefillOpen(false)}
                className="text-white/60"
              >
                Close
              </button>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">Quick buy. Checkout uses the existing token packs.</p>
            <div className="mt-4 space-y-3">
              {REFILL_PACKS.map((pack) => (
                <button
                  key={pack.tier}
                  type="button"
                  disabled={refillTier !== null}
                  onClick={() => void startRefill(pack.tier)}
                  className="flex w-full items-center justify-between border border-white/10 px-4 py-3 text-left text-white"
                >
                  <span>{pack.label}</span>
                  <span className="font-mono text-[#fda4af]">{refillTier === pack.tier ? "Loading…" : pack.price}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
