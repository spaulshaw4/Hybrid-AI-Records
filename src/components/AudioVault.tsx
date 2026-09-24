import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Download, Loader2, Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VaultMasterDock } from "@/components/VaultMasterDock";
import { masterWavFromUrl } from "@/lib/audio-mixdown";
import {
  playCatalogTrack,
  useCatalogPlayback,
} from "@/lib/catalog-player";
import { listUserVaultTracks, type UserVaultRow } from "@/lib/user-vault.functions";
import {
  fetchVaultTracksResult,
  VAULT_NEW_GENERATION_EVENT,
  VAULT_POLL_MAX_MS,
  VAULT_POLL_MS,
  type VaultTrackPayload,
} from "@/lib/vault-client";
import { logTransientPollDisconnect } from "@/lib/studio-poll-telemetry";
import {
  groupVaultTracksByArtistAlbum,
  isPlayableVaultAudioUrl,
  sanitizeVaultTracks,
} from "@/lib/vault-tracks";
import { guestTrackToPayload, listGuestVaultTracks } from "@/lib/guest-vault";
import {
  DEFAULT_CATALOG_DURATION_SEC,
  fetchWorkerVaultPayloads,
  formatDurationSeconds,
  resolveCatalogDurationSec,
  resolveCatalogGenre,
  resolveCatalogKey,
  vaultMasterUrls,
} from "@/lib/vault-catalog";

type Props = {
  /** Bump after Generate starts or finishes so the list refreshes immediately. */
  refreshKey?: number;
  signedIn: boolean;
  onDownload: (url: string, title: string) => void;
};

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
    musicalKey: clean?.musical_key ?? undefined,
    durationSec: clean?.duration_sec ?? undefined,
    mp3Url: clean?.mp3_url ?? undefined,
    zipUrl: clean?.zip_url ?? undefined,
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

function toPlayable(row: UserVaultRow, src: string) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artistName,
    src,
    audio_url: src,
    album: row.albumName,
    genre: row.style,
  };
}

export function AudioVault({ refreshKey = 0, signedIn, onDownload }: Props) {
  const loadVault = useServerFn(listUserVaultTracks);
  const [rows, setRows] = useState<UserVaultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [wavBusy, setWavBusy] = useState<string | null>(null);
  const playback = useCatalogPlayback();

  const refresh = useCallback(async () => {
    if (!signedIn) {
      try {
        const guest = await listGuestVaultTracks();
        const workerRows = await fetchWorkerVaultPayloads().catch(() => []);
        setRows((prev) =>
          mergeVaultRows(
            [...workerRows, ...guest.map((track) => guestTrackToPayload(track))].map(fromApi),
            prev,
          ),
        );
      } catch {
        setRows([]);
      }
      return;
    }
    try {
      const catalog = await fetchVaultTracksResult();
      if (catalog.transientFailure) {
        logTransientPollDisconnect({
          source: "vault_catalog",
          message: catalog.message,
          statusCode: catalog.status,
        });
      }
      const workerRows = await fetchWorkerVaultPayloads().catch(() => []);
      setRows((prev) =>
        mergeVaultRows([...workerRows, ...catalog.tracks].map(fromApi), prev),
      );
    } catch {
      try {
        const fallback = await loadVault({ data: undefined });
        const workerRows = await fetchWorkerVaultPayloads().catch(() => []);
        setRows((prev) => mergeVaultRows([...workerRows.map(fromApi), ...fallback], prev));
      } catch (error) {
        logTransientPollDisconnect({
          source: "vault_catalog",
          message: error instanceof Error ? error.message : "vault catalog unavailable",
        });
        console.warn(
          "[vault] Engine catalog unavailable",
          error instanceof Error ? error.message : error,
        );
        setRows((prev) => mergeVaultRows([], prev));
      }
    }
  }, [loadVault, signedIn]);

  useEffect(() => {
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
  const pollStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!processing) {
      pollStartedAtRef.current = null;
      return;
    }
    if (pollStartedAtRef.current == null) pollStartedAtRef.current = Date.now();

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") return;
      const started = pollStartedAtRef.current ?? Date.now();
      if (Date.now() - started > VAULT_POLL_MAX_MS) {
        setRows((prev) =>
          prev.map((row) =>
            row.status === "processing" ? { ...row, status: "failed" as const } : row,
          ),
        );
        pollStartedAtRef.current = null;
        if (timer) window.clearInterval(timer);
        return;
      }
      if (signedIn) void refresh();
    };

    timer = window.setInterval(tick, VAULT_POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
          musical_key: row.musicalKey ?? null,
          duration_sec: row.durationSec ?? null,
          mp3_url: row.mp3Url ?? null,
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

  function playRow(row: UserVaultRow) {
    const urls = vaultMasterUrls(row);
    if (!isPlayableVaultAudioUrl(urls.streamUrl)) return;
    void playCatalogTrack(toPlayable(row, urls.streamUrl), "vault").then(() => {
      const el = document.getElementById("hybrid-catalog-audio");
      if (!(el instanceof HTMLAudioElement)) return;
      const retry = () => {
        if (!urls.fallbackUrl || urls.fallbackUrl === urls.streamUrl) return;
        void playCatalogTrack(toPlayable(row, urls.fallbackUrl), "vault");
      };
      el.addEventListener("error", retry, { once: true });
    });
  }

  async function downloadMasterWav(row: UserVaultRow) {
    const urls = vaultMasterUrls(row);
    const fileName = `${fileSlug(row.title)}_master.wav`;
    if (/\.wav(\?|$)/i.test(urls.wavUrl)) {
      onDownload(urls.wavUrl, fileName);
      return;
    }
    if (!urls.wavUrl && !urls.streamUrl) {
      toast.error("Master WAV is not available for this track.");
      return;
    }
    setWavBusy(row.id);
    try {
      const wav = await masterWavFromUrl(urls.streamUrl || urls.wavUrl, { title: row.title });
      void import("@/lib/download-track").then(({ downloadTrack }) => {
        void downloadTrack(wav.url, fileName);
      });
      window.setTimeout(() => URL.revokeObjectURL(wav.url), 2_000);
    } catch {
      toast.error("Could not prepare the master WAV.");
    } finally {
      setWavBusy(null);
    }
  }

  return (
    <div className="vault-container mb-24 bg-zinc-900/40 backdrop-blur-xl border border-white/[0.08] shadow-2xl rounded-xl text-zinc-100 p-6 transition-all duration-200 hover:border-white/[0.15] hover:bg-zinc-900/55">
      <div className="mb-1 flex items-center justify-between gap-3 pb-4">
        <h3 className="text-lg font-bold text-zinc-100">Your Audio Vault</h3>
        <span className="text-xs text-zinc-400">Finished masters only</span>
      </div>

      <div id="vault-track-list" className="divide-y divide-zinc-800/50">
        {loading && rows.length === 0 ? (
          <p className="py-3 text-sm text-zinc-400">Loading vault assets…</p>
        ) : rows.length === 0 ? (
          <p className="py-3 text-sm text-zinc-400">
            {signedIn
              ? "No tracks saved. Hit Generate to start."
              : "No local tracks yet. Generate without signing in — we keep them on this device until you link an account."}
          </p>
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
                          <Table>
                            <TableHeader>
                              <TableRow className="border-zinc-800/80 hover:bg-transparent">
                                <TableHead className="pl-4 text-left text-zinc-400">
                                  Title
                                </TableHead>
                                <TableHead className="hidden text-zinc-400 sm:table-cell">
                                  Genre
                                </TableHead>
                                <TableHead className="hidden text-zinc-400 md:table-cell">
                                  Key
                                </TableHead>
                                <TableHead className="hidden text-zinc-400 md:table-cell">
                                  Duration
                                </TableHead>
                                <TableHead className="text-zinc-400">Status</TableHead>
                                <TableHead className="w-[5.5rem] text-end text-zinc-400">
                                  Actions
                                </TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
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
                                const genre = resolveCatalogGenre(row.style);
                                const keyLabel = resolveCatalogKey(
                                  row.style,
                                  row.title,
                                  row.musicalKey,
                                );
                                const durationSec = resolveCatalogDurationSec(
                                  row.durationSec,
                                  DEFAULT_CATALOG_DURATION_SEC,
                                );
                                const urls = vaultMasterUrls(row);
                                const ready = isPlayableVaultAudioUrl(urls.streamUrl);
                                const active =
                                  playback.owner === "vault" && playback.currentTrack?.id === row.id;
                                const playing = active && playback.playing;
                                return (
                                  <TableRow
                                    key={row.id}
                                    id={`vault-track-${row.id}`}
                                    className="track-row border-zinc-800/60"
                                  >
                                    <TableCell className="min-w-[8rem] pl-4 text-left font-medium text-zinc-100">
                                      <div className="min-w-0">
                                        <p className="truncate">{row.title}</p>
                                        <p className="text-[11px] font-normal text-zinc-500">
                                          {relativeStamp(row.createdAt)}
                                        </p>
                                      </div>
                                    </TableCell>
                                    <TableCell className="hidden text-zinc-300 sm:table-cell">
                                      {genre}
                                    </TableCell>
                                    <TableCell className="hidden font-mono text-xs text-zinc-300 md:table-cell">
                                      {keyLabel}
                                    </TableCell>
                                    <TableCell className="hidden tabular-nums text-zinc-300 md:table-cell">
                                      {formatDurationSeconds(durationSec)}
                                    </TableCell>
                                    <TableCell>
                                      {row.status === "processing" ? (
                                        <Badge
                                          variant="outline"
                                          className="border-amber-400/40 bg-amber-400/10 text-amber-300"
                                        >
                                          Processing
                                        </Badge>
                                      ) : row.status === "failed" ? (
                                        <Badge variant="destructive">Failed</Badge>
                                      ) : (
                                        <Badge className="border-transparent bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20">
                                          Ready
                                        </Badge>
                                      )}
                                    </TableCell>
                                    <TableCell className="w-[5.5rem] text-end">
                                      <div className="inline-flex items-center justify-end gap-0.5">
                                        {row.status === "processing" ? (
                                          <Loader2
                                            className="size-3.5 animate-spin text-muted-foreground"
                                            aria-hidden
                                          />
                                        ) : (
                                          <>
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="size-8"
                                              disabled={!ready}
                                              aria-label={
                                                playing ? `Pause ${row.title}` : `Play ${row.title}`
                                              }
                                              onClick={() => playRow(row)}
                                            >
                                              {playing ? (
                                                <Pause className="size-3.5" aria-hidden />
                                              ) : (
                                                <Play className="size-3.5" aria-hidden />
                                              )}
                                            </Button>
                                            <Button
                                              type="button"
                                              size="icon"
                                              variant="ghost"
                                              className="size-8"
                                              disabled={!urls.wavUrl && !urls.streamUrl}
                                              aria-label={`Download master WAV for ${row.title}`}
                                              onClick={() => void downloadMasterWav(row)}
                                            >
                                              {wavBusy === row.id ? (
                                                <Loader2
                                                  className="size-3.5 animate-spin"
                                                  aria-hidden
                                                />
                                              ) : (
                                                <Download className="size-3.5" aria-hidden />
                                              )}
                                            </Button>
                                          </>
                                        )}
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
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
      <VaultMasterDock />
    </div>
  );
}
