import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { isAudioVaultHttpsUrl } from "@/components/studio/CharacterModal";
import { TrackActionsMenu } from "@/components/studio/TrackActionsMenu";
import { openSiteSignIn } from "@/components/studio/UserAuthButton";

const EMPTY_COPY = "No ready masters yet. Create a track and it will show up here.";
const LOCKED_COPY = "Sign in to access your private Audio Vault and release-ready masters.";

export type VaultPendingRow = {
  id: string;
  title: string;
  status: string;
  genre?: string;
};

type VaultCard = {
  id: string;
  title: string;
  prompt: string;
  wavUrl: string | null;
  mp3Url: string | null;
  streamUrl: string | null;
  createdAt: string | null;
};

export type VaultTrackReference = {
  url: string;
  title: string;
};

type Props = {
  revision: number;
  pending?: VaultPendingRow[];
};

type VaultPage = PromiseLike<{
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
}>;

type VaultOrdered = {
  order: (column: string, options: { ascending: boolean }) => {
    limit: (count: number) => VaultPage;
  };
};

type VaultQuery = {
  select: (columns: string) => VaultOrdered & {
    eq: (column: string, value: string) => VaultOrdered;
  };
};

function publicAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.includes("/storage/v1/object/")) return text;
  const path = text.replace(/^\/+/, "");
  if (!path || path.includes("..")) return null;
  const { data } = supabase.storage.from("audio-vault").getPublicUrl(path);
  return data.publicUrl || null;
}

function sameResource(current: string, target: string): boolean {
  if (!current || !target) return false;
  try {
    return new URL(current, window.location.href).href === new URL(target, window.location.href).href;
  } catch {
    return current === target;
  }
}

function httpsUrl(value: string | null): string | null {
  const text = value?.trim() ?? "";
  if (!text || !/^https:\/\//i.test(text)) return null;
  return text;
}

/** mp3 when it is a non-empty https audio-vault URL; otherwise an https audio-vault wav. */
function referenceAudioUrl(mp3Url: string | null, wavUrl: string | null): string | null {
  const mp3 = httpsUrl(mp3Url);
  if (mp3 && isAudioVaultHttpsUrl(mp3)) return mp3;
  const wav = httpsUrl(wavUrl);
  if (wav && isAudioVaultHttpsUrl(wav)) return wav;
  return null;
}

function cardFromRow(row: Record<string, unknown>): VaultCard | null {
  const id = typeof row.id === "string" && row.id ? row.id : typeof row.task_id === "string" ? row.task_id : "";
  if (!id) return null;
  const mp3Url = publicAudioUrl(row.mp3_url);
  const wavUrl = publicAudioUrl(row.wav_url);
  const referenceUrl = referenceAudioUrl(mp3Url, wavUrl);
  const wavHttps = httpsUrl(wavUrl);
  const mp3Https = httpsUrl(mp3Url);
  return {
    id,
    title: typeof row.title === "string" && row.title.trim() ? row.title : "Untitled Master",
    prompt: typeof row.prompt === "string" ? row.prompt : typeof row.genre === "string" ? row.genre : "",
    wavUrl,
    mp3Url,
    streamUrl: referenceUrl || wavHttps || mp3Https,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

function masterCountLabel(count: number): string {
  return count === 1 ? "1 Master" : `${count} Masters`;
}

function barsFor(id: string): number[] {
  let seed = 0;
  for (let index = 0; index < id.length; index += 1) seed = (seed * 33 + id.charCodeAt(index)) >>> 0;
  return Array.from({ length: 28 }, (_, index) => {
    seed = (seed * 1664525 + 1013904223 + index) >>> 0;
    return 8 + (seed % 22);
  });
}

export function AudioVaultList({ revision, pending = [] }: Props) {
  const [rows, setRows] = useState<VaultCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const switched = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const sessionUser = sessionData.session?.user;
        const accessToken = sessionData.session?.access_token?.trim() ?? "";
        if (!sessionUser?.id) {
          if (!cancelled) {
            setRows([]);
            setLocked(true);
          }
          return;
        }
        if (!cancelled) setLocked(false);
        const query = await (supabase as unknown as { from: (table: string) => VaultQuery })
          .from("vaulted_tracks")
          .select("id, title, prompt, wav_url, mp3_url, created_at, user_id")
          .eq("user_id", sessionUser.id)
          .order("created_at", { ascending: false })
          .limit(20);
        if (!query.error && Array.isArray(query.data) && query.data.length > 0) {
          if (!cancelled) setRows(query.data.map(cardFromRow).filter((row): row is VaultCard => row !== null));
          return;
        }
        if (!accessToken) {
          if (!cancelled) setRows([]);
          return;
        }
        const response = await fetch("/api/vault", { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error("Could not load the vault.");
        const payload: unknown = await response.json();
        const tracks =
          payload && typeof payload === "object" && Array.isArray((payload as { tracks?: unknown }).tracks)
            ? (payload as { tracks: Array<Record<string, unknown>> }).tracks
            : [];
        if (!cancelled) setRows(tracks.map(cardFromRow).filter((row): row is VaultCard => row !== null));
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the vault.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const removeRow = async (id: string) => {
    if (!window.confirm("Permanently delete this master from the vault?")) return;
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token?.trim() ?? "";
      const response = await fetch(`/api/vault/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      const raw = await response.text();
      let data: { error?: string } = {};
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") data = parsed as { error?: string };
      } catch {
        throw new Error(`Server returned non-JSON (${response.status})`);
      }
      if (response.status === 404) throw new Error(data.error || "Vault track not found.");
      if (!response.ok) throw new Error(data.error || "Could not delete that master.");
      const audio = audioRefs.current.get(id);
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      setRows((current) => current.filter((row) => row.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not delete that master.");
    }
  };

  const visiblePending = pending.filter((row) => !rows.some((item) => item.id === row.id));
  const showCount = !loading && !locked;

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Your Audio Vault</h3>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "#94a3b8" }}>
          Permanent dual delivery. Ready WAV and MP3 masters stay in this list.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showCount ? (
          <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-zinc-300">
            {masterCountLabel(rows.length)}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setMinimized((value) => !value)}
          className="rounded-lg border border-white/10 px-2 py-1 text-xs text-zinc-100"
        >
          {minimized ? "+ Expand Vault" : "\u2212 Minimize Vault"}
        </button>
      </div>
    </div>
  );

  if (!loading && locked) {
    return (
      <div>
        {header}
        <Lock aria-hidden="true" size={18} color="#fda4af" style={{ marginTop: 12 }} />
        <p style={{ margin: "8px 0 0", fontSize: 13, color: "#94a3b8", lineHeight: 1.45 }}>{LOCKED_COPY}</p>
        <button
          type="button"
          onClick={() => openSiteSignIn()}
          style={{
            marginTop: 12,
            background: "linear-gradient(90deg, #e11d48 0%, #be123c 100%)",
            color: "#ffffff",
            border: "none",
            borderRadius: 8,
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Sign In
        </button>
      </div>
    );
  }

  return (
    <div>
      {header}
      {minimized ? null : (
      <div className="max-h-[380px] overflow-y-auto">
      {loading ? <p style={{ margin: "12px 0 0", fontSize: 13, color: "#94a3b8" }}>Loading your vault...</p> : null}
      {error ? <p style={{ margin: "12px 0 0", fontSize: 13, color: "#fda4af" }}>{error}</p> : null}
      {!loading && rows.length === 0 && visiblePending.length === 0 ? (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "#94a3b8" }}>{EMPTY_COPY}</p>
      ) : null}
      <ul style={{ listStyle: "none", margin: "12px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {visiblePending.map((row) => (
          <li key={row.id} style={{ borderTop: "1px solid #1e293b", paddingTop: 12 }}>
            <strong style={{ fontSize: 14 }}>{row.title}</strong>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: row.status === "Failed" ? "#f87171" : "#dc2626" }}>
              {row.genre || "Untitled style"} · {row.status}
            </p>
          </li>
        ))}
        {rows.map((row) => (
          <li key={row.id} style={{ borderTop: "1px solid #1e293b", paddingTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div>
                <strong style={{ fontSize: 14 }}>{row.title}</strong>
                <p style={{ margin: "4px 0 0", fontSize: 12, color: "#94a3b8" }}>
                  {(row.prompt || "Untitled style").slice(0, 48)}
                  {row.createdAt ? ` · ${new Date(row.createdAt).toLocaleDateString()}` : ""}
                </p>
              </div>
              <TrackActionsMenu
                title={row.title}
                mp3Url={row.mp3Url}
                wavUrl={row.wavUrl}
                onDelete={() => void removeRow(row.id)}
              />
            </div>
            <div aria-hidden="true" style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 32, marginTop: 8 }}>
              {barsFor(row.id).map((height, index) => (
                <span
                  key={`${row.id}-${index}`}
                  style={{ width: 3, height, borderRadius: 2, background: "#dc2626", opacity: 0.85 }}
                />
              ))}
            </div>
            {row.streamUrl ? (
              <audio
                ref={(element) => {
                  if (element) audioRefs.current.set(row.id, element);
                  else audioRefs.current.delete(row.id);
                }}
                controls
                controlsList="nodownload noplaybackrate"
                className="mt-2 w-full h-8"
                preload="none"
                src={row.streamUrl}
                onError={(event) => {
                  const element = event.currentTarget;
                  const fallback = httpsUrl(row.wavUrl);
                  if (switched.current.has(row.id) || !fallback || !row.streamUrl || fallback === row.streamUrl) return;
                  const current = element.currentSrc || element.src;
                  if (!sameResource(current, row.streamUrl) || sameResource(current, fallback)) return;
                  switched.current.add(row.id);
                  element.src = fallback;
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
      </div>
      )}
    </div>
  );
}
