import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { TrackActionsMenu } from "@/components/studio/TrackActionsMenu";

const EMPTY_COPY = "No ready masters yet. Create a track and it will show up here.";

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

type Props = {
  revision: number;
  pending?: VaultPendingRow[];
};

type VaultQuery = {
  select: (columns: string) => {
    order: (column: string, options: { ascending: boolean }) => {
      limit: (count: number) => PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      }>;
    };
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

function cardFromRow(row: Record<string, unknown>): VaultCard | null {
  const id = typeof row.id === "string" && row.id ? row.id : typeof row.task_id === "string" ? row.task_id : "";
  if (!id) return null;
  const mp3Url = publicAudioUrl(row.mp3_url);
  const wavUrl = publicAudioUrl(row.wav_url);
  return {
    id,
    title: typeof row.title === "string" && row.title.trim() ? row.title : "Untitled Master",
    prompt: typeof row.prompt === "string" ? row.prompt : typeof row.genre === "string" ? row.genre : "",
    wavUrl,
    mp3Url,
    streamUrl: mp3Url || wavUrl,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
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
        if (sessionData.session?.user) {
          const query = await (supabase as unknown as { from: (table: string) => VaultQuery })
            .from("vaulted_tracks")
            .select("id, title, prompt, wav_url, mp3_url, created_at, user_id")
            .order("created_at", { ascending: false })
            .limit(20);
          if (!query.error && Array.isArray(query.data)) {
            if (!cancelled) setRows(query.data.map(cardFromRow).filter((row): row is VaultCard => row !== null));
            return;
          }
        }
        const response = await fetch("/api/vault");
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
      const response = await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: "DELETE" });
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

  return (
    <div>
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
                trackId={row.id}
                title={row.title}
                mp3Url={row.mp3Url}
                wavUrl={row.wavUrl}
                onDelete={(id) => void removeRow(id)}
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
                preload="none"
                src={row.streamUrl}
                style={{ width: "100%", marginTop: 8 }}
                onError={(event) => {
                  const element = event.currentTarget;
                  if (switched.current.has(row.id) || !row.mp3Url || !row.wavUrl || row.mp3Url === row.wavUrl) return;
                  const current = element.currentSrc || element.src;
                  if (!sameResource(current, row.mp3Url) || sameResource(current, row.wavUrl)) return;
                  switched.current.add(row.id);
                  element.src = row.wavUrl;
                  void element.play().catch(() => undefined);
                }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
