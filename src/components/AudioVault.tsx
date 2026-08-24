import { useCallback, useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, Download, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import {
  groupVaultTracksByArtistAlbum,
  isPlayableVaultAudioUrl,
  sanitizeVaultTracks,
} from "@/lib/vault-tracks";

type Props = {
  /** Bump after Generate starts or finishes so the list refreshes immediately. */
  refreshKey?: number;
  signedIn: boolean;
  onDownload: (url: string, title: string) => void;
};

type StemKind = "master" | "raw" | "acapella" | "instrumental";

/** Export rows, in the order they appear under the player. */
const EXPORT_ROWS: Array<{ kind: StemKind; label: string }> = [
  { kind: "master", label: "Master Track" },
  { kind: "raw", label: "Raw Pre-Master" },
  { kind: "acapella", label: "Clean Vocal Stem" },
  { kind: "instrumental", label: "Instrumental Stem" },
];

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
    stem === "master"
      ? "Full_Master"
      : stem === "raw"
        ? "Raw_Pre_Master"
        : stem === "acapella"
          ? "Acapella"
          : "Instrumental";
  return `${fileSlug(title)}_${suffix}.${ext}`;
}

function stemUrl(row: UserVaultRow, stem: StemKind): string {
  if (stem === "master") return row.masterUrl;
  if (stem === "raw") return row.rawAudioUrl;
  if (stem === "acapella") return row.vocalUrl;
  return row.instrumentalUrl;
}

function fromApi(track: VaultTrackPayload): UserVaultRow {
  const [clean] = sanitizeVaultTracks([track]);
  return {
    id: clean?.id ?? track.id,
    title: clean?.title || "Untitled Track",
    style: clean?.style || "Custom",
    status: clean?.status ?? "processing",
    masterUrl: clean?.master_url ?? "",
    instrumentalUrl: clean?.instrumental_url ?? "",
    vocalUrl: clean?.vocal_url ?? "",
    rawAudioUrl: clean?.raw_audio_url ?? "",
    createdAt: clean?.created_at ?? track.created_at,
    artistName: clean?.artist_name ?? track.artist_name ?? "Unknown Artist",
    albumName: clean?.album_name ?? track.album_name ?? "Singles",
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
        (row.status === "processing" || incoming.status === "completed")
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
  const [pendingDelete, setPendingDelete] = useState<UserVaultRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [wavBusy, setWavBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const tracks = await fetchVaultTracks();
      setRows((prev) => mergeVaultRows(tracks.map(fromApi), prev));
    } catch {
      try {
        const fallback = await loadVault({ data: undefined });
        setRows((prev) => mergeVaultRows(fallback, prev));
      } catch (error) {
        console.warn(
          "[vault] Engine catalog unavailable",
          error instanceof Error ? error.message : error,
        );
        setRows((prev) => mergeVaultRows([], prev));
      }
    }
  }, [loadVault, signedIn]);

  useEffect(() => {
    if (!signedIn) {
      setRows([]);
      setLoading(false);
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
      if (detail.status === "completed" || detail.master_url) {
        void refresh();
      }
    };
    window.addEventListener(VAULT_NEW_GENERATION_EVENT, onNewGeneration);
    return () => window.removeEventListener(VAULT_NEW_GENERATION_EVENT, onNewGeneration);
  }, [refresh]);

  const processing = rows.some((row) => row.status === "processing");
  useEffect(() => {
    if (!processing || !signedIn) return;
    const timer = window.setInterval(() => void refresh(), VAULT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, signedIn, refresh]);

  const [openAlbums, setOpenAlbums] = useState<string[]>([]);

  const grouped = useMemo(
    () =>
      groupVaultTracksByArtistAlbum(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          style: row.style,
          status: row.status,
          master_url: row.masterUrl || null,
          instrumental_url: row.instrumentalUrl || null,
          vocal_url: row.vocalUrl || null,
          raw_audio_url: row.rawAudioUrl || null,
          created_at: row.createdAt,
          artist_name: row.artistName,
          album_name: row.albumName,
        })),
      ),
    [rows],
  );

  const defaultOpenAlbums = useMemo(
    () =>
      grouped.flatMap((artist) =>
        artist.albums.map((album) => `${artist.artist_name}::${album.album_name}`),
      ),
    [grouped],
  );

  useEffect(() => {
    setOpenAlbums(defaultOpenAlbums);
  }, [defaultOpenAlbums]);

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
    <div className="vault-container bg-zinc-900/80 backdrop-blur-md border border-zinc-800 shadow-2xl rounded-xl text-zinc-100 divide-y divide-zinc-800/50 p-6">
      <div className="mb-1 flex items-center justify-between gap-3 pb-4">
        <h3 className="text-lg font-bold text-zinc-100">Your Audio Vault</h3>
        <span className="text-xs text-zinc-400">Manage, stream, and export stems</span>
      </div>

      <div id="vault-track-list" className="divide-y divide-zinc-800/50">
        {!signedIn ? (
          <p className="py-3 text-sm text-zinc-400">Sign in to keep every generate in your vault.</p>
        ) : loading && rows.length === 0 ? (
          <p className="py-3 text-sm text-zinc-400">Loading vault assets…</p>
        ) : rows.length === 0 ? (
          <p className="py-3 text-sm text-zinc-400">No tracks saved. Hit Generate to start.</p>
        ) : (
          <div className="space-y-4 pt-2">
            {grouped.map((artist) => (
              <section key={artist.artist_name} className="space-y-2">
                <h4 className="pt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                  {artist.artist_name}
                </h4>
                <Accordion
                  type="multiple"
                  value={openAlbums.filter((key) => key.startsWith(`${artist.artist_name}::`))}
                  onValueChange={(values) => {
                    setOpenAlbums((prev) => {
                      const other = prev.filter((key) => !key.startsWith(`${artist.artist_name}::`));
                      return [...other, ...values];
                    });
                  }}
                  className="rounded-lg border border-zinc-800/80 bg-zinc-950/40"
                >
                  {artist.albums.map((album) => {
                    const albumKey = `${artist.artist_name}::${album.album_name}`;
                    return (
                      <AccordionItem
                        key={albumKey}
                        value={albumKey}
                        className="border-zinc-800/60 px-3"
                      >
                        <AccordionTrigger className="py-3 text-zinc-100 hover:no-underline">
                          <span className="flex min-w-0 flex-1 items-center justify-between gap-3 pe-2">
                            <span className="truncate text-sm font-semibold">{album.album_name}</span>
                            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
                              {album.tracks.length} track
                              {album.tracks.length === 1 ? "" : "s"}
                            </span>
                          </span>
                        </AccordionTrigger>
                        <AccordionContent className="pb-3">
                          <div className="divide-y divide-zinc-800/50">
                            {album.tracks.map((track) => {
                              const row =
                                rows.find((r) => r.id === track.id) ??
                                fromApi({
                                  ...track,
                                  master_url: track.master_url,
                                  instrumental_url: track.instrumental_url,
                                  vocal_url: track.vocal_url,
                                  raw_audio_url: track.raw_audio_url,
                                });
                              return (
                                <div
                                  key={row.id}
                                  id={`vault-track-${row.id}`}
                                  className="track-row flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                                >
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-zinc-100">
                                      {row.title}
                                    </p>
                                    <p className="text-xs text-zinc-400">
                                      Generated: {relativeStamp(row.createdAt)} • Status:{" "}
                                      {row.status === "processing" ? (
                                        <span className="inline-flex items-center gap-1 font-semibold text-amber-400">
                                          <span
                                            className="size-1.5 animate-pulse rounded-full bg-amber-400"
                                            aria-hidden
                                          />
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
                                    {isPlayableVaultAudioUrl(row.masterUrl) ? (
                                      <>
                                        <audio
                                          controls
                                          className="h-8 max-w-[200px]"
                                          src={row.masterUrl}
                                          preload="none"
                                        >
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
                                          <DropdownMenuContent align="end" className="min-w-64">
                                            {EXPORT_ROWS.map(({ kind, label }, index) => {
                                              const url = stemUrl(row, kind);
                                              return (
                                                <div key={kind}>
                                                  {index > 0 ? <DropdownMenuSeparator /> : null}
                                                  <DropdownMenuLabel className="flex items-center justify-between gap-2">
                                                    <span>{label}</span>
                                                    {url ? null : (
                                                      <span className="text-[10px] font-normal text-muted-foreground">
                                                        unavailable
                                                      </span>
                                                    )}
                                                  </DropdownMenuLabel>
                                                  <div className="flex gap-1 px-1 pb-1">
                                                    <DropdownMenuItem
                                                      className="flex-1 justify-center rounded border border-border/60 text-xs"
                                                      disabled={!url || wavBusy !== null}
                                                      onSelect={() =>
                                                        void downloadWav(url, row.title, kind)
                                                      }
                                                    >
                                                      WAV
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem
                                                      className="flex-1 justify-center rounded border border-border/60 text-xs"
                                                      disabled={!url}
                                                      onSelect={() =>
                                                        onDownload(
                                                          url,
                                                          stemFileName(row.title, kind, "mp3"),
                                                        )
                                                      }
                                                    >
                                                      MP3
                                                    </DropdownMenuItem>
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      </>
                                    ) : row.status === "processing" ? (
                                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                        Rendering in the background
                                      </span>
                                    ) : null}

                                    {row.status !== "processing" ? (
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
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              </section>
            ))}
          </div>
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
