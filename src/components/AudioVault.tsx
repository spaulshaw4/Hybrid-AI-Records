import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { masterWavFromUrl } from "@/lib/audio-mixdown";
import {
  deleteUserVaultTrack,
  listUserVaultTracks,
  type UserVaultRow,
} from "@/lib/user-vault.functions";
import {
  deleteVaultTrackApi,
  fetchVaultTracks,
  isPersistedVaultId,
  VAULT_NEW_GENERATION_EVENT,
  VAULT_POLL_MS,
  type VaultTrackPayload,
} from "@/lib/vault-client";

type Props = {
  /** Bump after Generate starts or finishes so the list refreshes immediately. */
  refreshKey?: number;
  signedIn: boolean;
  onDownload: (url: string, title: string) => void;
};

type StemKind = "master" | "acapella" | "instrumental";

function relativeStamp(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return "";
  const delta = Date.now() - at;
  if (delta < 45_000) return "Just now";
  if (delta < 90_000) return "1 min ago";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} min ago`;
  if (delta < 48 * 3_600_000) return `${Math.round(delta / 3_600_000)} hr ago`;
  return new Date(at).toLocaleDateString();
}

function fileSlug(title: string): string {
  return title.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "Track";
}

function stemFileName(title: string, stem: StemKind, ext: "mp3" | "wav"): string {
  const suffix =
    stem === "master" ? "Full_Master" : stem === "acapella" ? "Acapella" : "Instrumental";
  return `${fileSlug(title)}_${suffix}.${ext}`;
}

function fromApi(track: VaultTrackPayload): UserVaultRow {
  return {
    id: track.id,
    title: track.title || "Untitled Track",
    style: track.style || "Custom",
    status: track.status,
    masterUrl: track.master_url ?? "",
    instrumentalUrl: track.instrumental_url ?? "",
    vocalUrl: track.vocal_url ?? "",
    createdAt: track.created_at,
  };
}

function mergeVaultRows(apiRows: UserVaultRow[], previous: UserVaultRow[]): UserVaultRow[] {
  const apiIds = new Set(apiRows.map((row) => row.id));
  const keepTemps = previous.filter(
    (row) =>
      row.id.startsWith("temp-") &&
      !apiIds.has(row.id) &&
      !apiRows.some((api) => api.title === row.title && api.status === "processing"),
  );
  return [...keepTemps, ...apiRows];
}

function upsertProcessing(previous: UserVaultRow[], incoming: UserVaultRow): UserVaultRow[] {
  const withoutTemps = previous.filter(
    (row) =>
      !(
        row.id.startsWith("temp-") &&
        row.title === incoming.title &&
        row.status === "processing"
      ),
  );
  if (withoutTemps.some((row) => row.id === incoming.id)) {
    return withoutTemps.map((row) => (row.id === incoming.id ? { ...row, ...incoming } : row));
  }
  return [incoming, ...withoutTemps];
}

function triggerBlobDownload(url: string, fileName: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function AudioVault({ refreshKey = 0, signedIn, onDownload }: Props) {
  const loadVault = useServerFn(listUserVaultTracks);
  const removeVault = useServerFn(deleteUserVaultTrack);
  const [rows, setRows] = useState<UserVaultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<UserVaultRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [wavBusy, setWavBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const tracks = await fetchVaultTracks();
      setLoadError(false);
      setRows((prev) => mergeVaultRows(tracks.map(fromApi), prev));
    } catch {
      try {
        const fallback = await loadVault({ data: undefined });
        setLoadError(false);
        setRows((prev) => mergeVaultRows(fallback, prev));
      } catch {
        setLoadError(true);
      }
    }
  }, [loadVault, signedIn]);

  useEffect(() => {
    if (!signedIn) {
      setRows([]);
      setLoading(false);
      setLoadError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, refreshKey, signedIn]);

  useEffect(() => {
    const onNewGeneration = (event: Event) => {
      const detail = (event as CustomEvent<VaultTrackPayload>).detail;
      if (!detail?.id) return;
      setRows((prev) => upsertProcessing(prev, fromApi(detail)));
    };
    window.addEventListener(VAULT_NEW_GENERATION_EVENT, onNewGeneration);
    return () => window.removeEventListener(VAULT_NEW_GENERATION_EVENT, onNewGeneration);
  }, []);

  const processing = rows.some((row) => row.status === "processing");
  useEffect(() => {
    if (!processing || !signedIn) return;
    const timer = window.setInterval(() => void refresh(), VAULT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, signedIn, refresh]);

  async function downloadWav(url: string, title: string, stem: StemKind) {
    const key = `${title}:${stem}:wav`;
    setWavBusy(key);
    try {
      const wav = await masterWavFromUrl(url, { title });
      triggerBlobDownload(wav.url, stemFileName(title, stem, "wav"));
      window.setTimeout(() => URL.revokeObjectURL(wav.url), 2_000);
    } catch {
      toast.error("Could not prepare the WAV. Try the MP3 download instead.");
    } finally {
      setWavBusy(null);
    }
  }

  async function confirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    if (target.id.startsWith("temp-")) {
      setRows((prev) => prev.filter((row) => row.id !== target.id));
      toast.success("Track deleted.");
      return;
    }
    setDeletingId(target.id);
    try {
      if (isPersistedVaultId(target.id)) {
        try {
          await deleteVaultTrackApi(target.id);
        } catch {
          await removeVault({ data: { id: target.id } });
        }
      } else {
        await removeVault({ data: { id: target.id } });
      }
      setRows((prev) => prev.filter((row) => row.id !== target.id));
      toast.success("Track deleted.");
    } catch {
      toast.error("Could not delete that track. Please try again.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="vault-container space-y-4 rounded-xl border border-border bg-card/90 p-6">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold text-foreground">Your Audio Vault</h3>
        <span className="text-xs text-muted-foreground">Manage, stream, and export stems</span>
      </div>

      <div id="vault-track-list" className="space-y-3">
        {!signedIn ? (
          <p className="text-sm text-muted-foreground">Sign in to keep every generate in your vault.</p>
        ) : loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading vault assets…</p>
        ) : loadError && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Error loading vault. Please refresh.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tracks saved. Hit Generate to start.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              id={`vault-track-${row.id}`}
              className="track-row flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{row.title}</p>
                <p className="text-xs text-muted-foreground">
                  Generated: {relativeStamp(row.createdAt)} • Status:{" "}
                  {row.status === "processing" ? (
                    <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                      <span className="size-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden />
                      Processing...
                    </span>
                  ) : row.status === "failed" ? (
                    <span className="font-semibold text-destructive">Failed</span>
                  ) : (
                    <span className="font-semibold text-emerald-400">Ready</span>
                  )}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {row.status === "completed" && row.masterUrl ? (
                  <>
                    <audio controls className="h-8 max-w-[200px]" src={row.masterUrl} preload="none">
                      <track kind="captions" />
                    </audio>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" size="sm" className="h-8 px-3 text-xs">
                          <Download className="size-3.5" aria-hidden />
                          Download
                          <ChevronDown className="size-3.5" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-56">
                        <DropdownMenuLabel>Full Master</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={!row.masterUrl}
                          onSelect={() => onDownload(row.masterUrl, stemFileName(row.title, "master", "mp3"))}
                        >
                          MP3
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!row.masterUrl || wavBusy !== null}
                          onSelect={() => void downloadWav(row.masterUrl, row.title, "master")}
                        >
                          WAV
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Acapella (Vocal Stem)</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={!row.vocalUrl}
                          onSelect={() => onDownload(row.vocalUrl, stemFileName(row.title, "acapella", "mp3"))}
                        >
                          MP3
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!row.vocalUrl || wavBusy !== null}
                          onSelect={() => void downloadWav(row.vocalUrl, row.title, "acapella")}
                        >
                          WAV
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Instrumental</DropdownMenuLabel>
                        <DropdownMenuItem
                          disabled={!row.instrumentalUrl}
                          onSelect={() =>
                            onDownload(row.instrumentalUrl, stemFileName(row.title, "instrumental", "mp3"))
                          }
                        >
                          MP3
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!row.instrumentalUrl || wavBusy !== null}
                          onSelect={() => void downloadWav(row.instrumentalUrl, row.title, "instrumental")}
                        >
                          WAV
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : row.status === "processing" ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    Rendering in the background
                  </span>
                ) : null}

                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 px-3 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
                  disabled={deletingId === row.id}
                  onClick={() => setPendingDelete(row)}
                >
                  {deletingId === row.id ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden />
                  )}
                  Delete
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this track?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.title ?? "This track"}” and its master and stem files are removed
              permanently. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep track</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
