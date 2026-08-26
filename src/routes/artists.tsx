import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Download,
  ListChecks,
  Pause,
  Play,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { pageHead } from "@/lib/social-meta";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { LocaleCluster } from "@/components/SiteNav";
import { ArtistTokenStore, useArtistTokens } from "@/components/ArtistTokenStore";
import { TrackWaveform } from "@/components/TrackWaveform";
import { ALBUMS, STREAM_TRACKS, type Album, type StreamTrack } from "@/lib/radio-tracks";
import {
  groupPlayablesAsAlbums,
  playableToStreamTrack,
  type CatalogPlayable,
} from "@/lib/artist-catalog";
import { dedupeTracks } from "@/lib/radio-tracks";
import { fetchArtistCatalogTracks } from "@/lib/fetch-artist-catalog";
import {
  playCatalogTrack,
  seekCatalogPlayback,
  useCatalogPlayback,
} from "@/lib/catalog-player";
import { CoverImage } from "@/components/CoverImage";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CRESTS, type Division } from "@/lib/divisions";
import { getArtistTrackDownloadCounts } from "@/lib/artist-tokens.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

type ArtistsSearch = { album?: string };

export const Route = createFileRoute("/artists")({
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>): ArtistsSearch => ({
    album: typeof search.album === "string" && search.album.trim() ? search.album.trim() : undefined,
  }),
  head: () =>
    pageHead({
      path: "/artists",
      title: "Artist Tracks & Downloads | Hybrid AI Records",
      description:
        "Browse Hybrid AI Records by album cover, open an album for its tracks, preview any song, and unlock permanent downloads with Artist Tokens — $1 per track.",
      socialTitle: "Artist Tracks & Downloads | Hybrid AI Records",
      socialDescription:
        "Album-first label catalog — pick a cover, preview tracks, unlock and download with Artist Tokens.",
      type: "website",
      card: "summary_large_image",
    }),
  component: ArtistTracksPage,
});

type SortMode = "newest" | "title" | "track" | "price" | "popularity";

function DivisionBadge({ division }: { division?: Division }) {
  if (!division) return null;
  const crest = CRESTS[division];
  return (
    <div className="flex items-center gap-2 rounded-full border border-border-strong bg-ink/40 px-3 py-1.5">
      <img
        src={crest.src}
        srcSet={crest.srcSet}
        sizes="24px"
        alt={crest.alt}
        className="size-6 bg-transparent object-contain"
        loading="lazy"
      />
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {crest.label}
      </span>
    </div>
  );
}

function formatTime(s: number) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}




function ArtistTracksPage() {
  const tokens = useArtistTokens();
  const navigate = useNavigate({ from: "/artists" });
  const { album: albumParam } = Route.useSearch();
  const playback = useCatalogPlayback();

  const [catalog, setCatalog] = useState<CatalogPlayable[]>([]);
  const [query, setQuery] = useState("");
  const [activeGenre, setActiveGenre] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortMode>("track");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [detailTrackId, setDetailTrackId] = useState<string | null>(null);
  const [popularity, setPopularity] = useState<Map<string, number>>(new Map());
  const [popularityError, setPopularityError] = useState(false);
  const [popularityRetry, setPopularityRetry] = useState(0);

  const catalogAlbums = useMemo(() => groupPlayablesAsAlbums(catalog), [catalog]);
  const albumsSource: Album[] = catalogAlbums.length ? catalogAlbums : ALBUMS;
  const tracksSource: StreamTrack[] = useMemo(() => {
    if (!catalog.length) return STREAM_TRACKS;
    // Live artist_tracks is the only source once loaded — never merge with the
    // static STREAM_TRACKS list (different ids / drifted titles caused doubles).
    return dedupeTracks(catalog.map(playableToStreamTrack));
  }, [catalog]);

  const selectedAlbum =
    albumsSource.find((a) => a.id === albumParam) ??
    albumsSource.find((a) => a.title === albumParam) ??
    null;

  const playingId = playback.playing ? playback.currentTrack?.id ?? playback.track?.id ?? null : null;
  const activeId = playback.currentTrack?.id ?? playback.track?.id ?? null;
  const currentTime = playback.currentTime;
  const duration = playback.duration;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchArtistCatalogTracks();
        if (!cancelled) setCatalog(rows);
      } catch (error) {
        console.error("[artists] catalog fetch failed:", error);
        if (!cancelled) setCatalog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load anonymous popularity counts once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const counts = await getArtistTrackDownloadCounts({ data: undefined });
        if (cancelled) return;
        setPopularityError(false);
        setPopularity(new Map(counts.map((c) => [c.trackId, c.count])));
      } catch {
        // Surface the failure: an empty map otherwise reads as "nobody
        // downloaded anything" instead of "we couldn't load the counts".
        if (!cancelled) setPopularityError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popularityRetry]);


  const genres = useMemo(
    () => Array.from(new Set(albumsSource.map((a) => a.genre).filter(Boolean))).sort() as string[],
    [albumsSource],
  );

  const albums = useMemo(() => {
    let list = albumsSource;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((a) => {
        const hay = `${a.title} ${a.artist} ${a.genre} ${a.tracks.map((t) => t.title).join(" ")}`;
        return hay.toLowerCase().includes(q);
      });
    }
    if (activeGenre) list = list.filter((a) => a.genre === activeGenre);
    return list;
  }, [albumsSource, query, activeGenre]);

  const tracks = useMemo(() => {
    let list = tracksSource;
    if (selectedAlbum) {
      list = list.filter((t) => t.album === selectedAlbum.title);
    }
    const q = query.trim().toLowerCase();
    if (q && selectedAlbum) {
      list = list.filter((t) =>
        `${t.title} ${t.artist} ${t.album ?? ""} ${t.genre ?? ""}`.toLowerCase().includes(q),
      );
    }
    if (activeGenre && selectedAlbum) {
      list = list.filter((t) => t.genre === activeGenre);
    }
    switch (sortBy) {
      case "newest":
        list = [...list].sort((a, b) => (b.releaseOrder ?? 0) - (a.releaseOrder ?? 0));
        break;
      case "title":
        list = [...list].sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
        );
        break;
      case "track":
        list = [...list].sort(
          (a, b) =>
            (a.trackNumber ?? Number.MAX_SAFE_INTEGER) -
              (b.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
            a.title.localeCompare(b.title),
        );
        break;
      case "price":
        list = [...list].sort((a, b) => (a.priceTokens ?? 1) - (b.priceTokens ?? 1));
        break;
      case "popularity":
        list = [...list].sort((a, b) => {
          const pa = popularity.get(a.id) ?? 0;
          const pb = popularity.get(b.id) ?? 0;
          if (pb !== pa) return pb - pa;
          return (b.releaseOrder ?? 0) - (a.releaseOrder ?? 0);
        });
        break;
    }
    return list;
  }, [tracksSource, query, activeGenre, sortBy, popularity, selectedAlbum]);

  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageTracks = useMemo(
    () => tracks.slice(pageStart, pageStart + pageSize),
    [tracks, pageStart, pageSize],
  );

  // Reset to the first page whenever the result set changes.
  useEffect(() => {
    setPage(1);
  }, [query, activeGenre, sortBy, pageSize]);

  const detailTrack = useMemo(
    () => tracksSource.find((t) => t.id === detailTrackId) ?? null,
    [detailTrackId, tracksSource],
  );

  const ownedTracks = useMemo(
    () => tracks.filter((t) => tokens.unlocked.has(t.id)),
    [tracks, tokens.unlocked],
  );

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitBulk = () => {
    setBulkMode(false);
    setSelected(new Set());
    setBulkProgress(null);
  };

  const openAlbum = (albumId: string) => {
    void navigate({ search: { album: albumId } });
    setSortBy("track");
    setPage(1);
    exitBulk();
  };

  const backToAlbums = () => {
    void navigate({ search: {}, replace: true });
    setPage(1);
    exitBulk();
  };

  const runBulkDownload = async () => {
    const ids = ownedTracks.filter((t) => selected.has(t.id)).map((t) => t.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkProgress({ done: 0, total: ids.length });
    let done = 0;
    for (const id of ids) {
      // Each call mints a fresh short-lived signed link server-side.
      await tokens.download(id);
      done += 1;
      setBulkProgress({ done, total: ids.length });
      await new Promise((r) => setTimeout(r, 700));
    }
    setBulkBusy(false);
    setBulkProgress(null);
    toast.success("Bulk download complete", {
      description: `${done} track${done === 1 ? "" : "s"} downloaded with fresh secure links.`,
    });
    setSelected(new Set());
  };

  const preview = (id: string, srcOrAudioUrl: string) => {
    const track =
      tracksSource.find((t) => t.id === id) ??
      ({
        id,
        title: id,
        artist: "Hybrid AI Records",
        src: srcOrAudioUrl,
      } satisfies StreamTrack);
    const fromCatalog = catalog.find((c) => c.id === id);
    const audioUrl = (
      fromCatalog?.audio_url ||
      fromCatalog?.src ||
      track.src ||
      srcOrAudioUrl ||
      ""
    ).trim();
    console.log("Playing audio URL:", audioUrl, { id, title: track.title });
    if (!audioUrl) {
      console.error("[artists] no audio_url/src for track", id);
      return;
    }
    void playCatalogTrack(
      {
        id: track.id,
        title: track.title,
        artist: track.artist,
        src: audioUrl,
        audio_url: audioUrl,
        cover: fromCatalog?.cover ?? track.cover,
        album: fromCatalog?.album ?? track.album,
        genre: fromCatalog?.genre ?? track.genre,
        credits: fromCatalog?.credits ?? track.credits,
        trackNumber: fromCatalog?.trackNumber ?? track.trackNumber,
        trackTotal: fromCatalog?.trackTotal ?? track.trackTotal,
        division: fromCatalog?.division ?? track.division,
        priceTokens: fromCatalog?.priceTokens ?? track.priceTokens,
      },
      selectedAlbum ? "album" : "artists",
    );
  };

  const seek = (time: number) => {
    seekCatalogPlayback(time);
  };




  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <PortalBreadcrumb
        trail={
          selectedAlbum
            ? [
                { label: "Artist tracks", to: "/artists", search: {} },
                { label: selectedAlbum.title },
              ]
            : [{ label: "Artist tracks" }]
        }
        end={<LocaleCluster className="hidden lg:inline-flex" />}
      />

      {selectedAlbum ? (
        <button
          type="button"
          onClick={backToAlbums}
          className="mt-6 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground transition hover:text-primary"
        >
          <ArrowLeft size={14} aria-hidden />
          All albums
        </button>
      ) : null}

      <h1 className="mt-6 font-display text-2xl uppercase tracking-[0.14em] text-foreground">
        {selectedAlbum ? selectedAlbum.title : "Artist Tracks"}
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        {selectedAlbum
          ? `${selectedAlbum.artist} · ${selectedAlbum.tracks.length} track${selectedAlbum.tracks.length === 1 ? "" : "s"} — preview any song and unlock a permanent download with an Artist Token.`
          : "Browse by album cover, open an album for its tracks, preview any song, and unlock downloads with Artist Tokens. $1 = 1 track, yours forever."}
      </p>

      {/* Token status bar */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-strong bg-ink/60 p-5 backdrop-blur">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Artist Tokens
          </p>
          <p className="mt-1 font-display text-3xl text-foreground">
            {tokens.signedIn ? (tokens.balance ?? "—") : "—"}
          </p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {tokens.signedIn ? `${tokens.unlocked.size} tracks owned` : "Sign in to see your tokens"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tokens.signedIn ? (
            <>
              <button
                type="button"
                onClick={() => tokens.setStoreOpen(true)}
                className="rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
              >
                Buy Artist Tokens
              </button>
              <Link
                to="/account/downloads"
                className="rounded-md border border-border-strong px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground transition hover:border-primary hover:text-primary"
              >
                My downloads
              </Link>
            </>
          ) : (
            <Link
              to="/auth"
              className="rounded-md bg-primary px-4 py-2.5 font-mono text-xs uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>

      {tokens.notice ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {tokens.notice}
        </p>
      ) : null}

      {/* Search + sort */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-border-strong bg-ink/40 px-3 py-2.5">
          <Search size={15} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              selectedAlbum
                ? "Search tracks on this album"
                : "Search albums, artists or songs"
            }
            aria-label={selectedAlbum ? "Search tracks on this album" : "Search albums"}
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        {selectedAlbum ? (
          <div className="flex items-center gap-2">
            <SlidersHorizontal size={14} className="text-muted-foreground" aria-hidden />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortMode)}
              aria-label="Sort tracks"
              className="rounded-lg border border-border-strong bg-ink/40 px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="track">Track order</option>
              <option value="title">Title: A–Z</option>
              <option value="newest">Newest first</option>
              <option value="price">Price: low to high</option>
              <option value="popularity">Most popular</option>
            </select>
          </div>
        ) : null}
      </div>

      {popularityError ? (
        <p role="alert" className="mt-3 text-xs text-muted-foreground">
          We couldn&apos;t load download counts, so &ldquo;Most popular&rdquo; is unsorted.{" "}
          <button
            type="button"
            onClick={() => setPopularityRetry((n) => n + 1)}
            className="font-mono uppercase tracking-[0.16em] text-primary underline underline-offset-4"
          >
            Retry
          </button>
        </p>
      ) : null}



      {/* Genre filters — albums grid only */}
      {!selectedAlbum && genres.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveGenre(null)}
            className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition ${
              activeGenre === null
                ? "border-primary bg-primary/10 text-primary"
                : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
            }`}
          >
            All
          </button>
          {genres.map((genre) => (
            <button
              key={genre}
              type="button"
              onClick={() => setActiveGenre(genre)}
              className={`rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] transition ${
                activeGenre === genre
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
              }`}
            >
              {genre}
            </button>
          ))}
        </div>
      ) : null}

      {!selectedAlbum ? (
        <>
          <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {albums.length === 0
              ? "0 albums"
              : `${albums.length} album${albums.length === 1 ? "" : "s"}`}
          </p>

          <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {albums.map((album, ai) => (
              <li key={album.id}>
                <button
                  type="button"
                  onClick={() => openAlbum(album.id)}
                  className="group flex w-full flex-col overflow-hidden rounded-xl border border-border-strong bg-ink/50 text-start transition hover:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  aria-label={`Open album ${album.title} by ${album.artist}`}
                >
                  <span className="relative aspect-square w-full overflow-hidden bg-ink">
                    {album.cover ? (
                      <CoverImage
                        src={album.cover}
                        alt={`${album.title} album cover`}
                        priority={ai < 4}
                        sizes="(min-width: 1024px) 20vw, (min-width: 640px) 30vw, 50vw"
                        width={640}
                        height={640}
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                        onError={() => {
                          console.warn("[artists] album card cover failed:", {
                            album: album.title,
                            cover_url: album.cover,
                          });
                        }}
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        No cover
                      </span>
                    )}
                  </span>
                  <span className="border-t border-border-strong p-3">
                    <span className="block truncate font-display text-sm font-semibold text-foreground">
                      {album.title}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {album.artist}
                    </span>
                    <span className="mt-2 block font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {album.tracks.length} track{album.tracks.length === 1 ? "" : "s"}
                      {album.genre ? ` · ${album.genre}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {albums.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">No albums match that search.</p>
          ) : null}
        </>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-end">
            {selectedAlbum.cover ? (
              <CoverImage
                src={selectedAlbum.cover}
                alt={`${selectedAlbum.title} album cover`}
                sizes="(min-width: 640px) 11rem, 40vw"
                width={640}
                height={640}
                className="aspect-square w-40 shrink-0 rounded-xl border border-border-strong object-cover shadow-lg sm:w-44"
                onError={() => {
                  console.warn("[artists] album header cover failed:", {
                    album: selectedAlbum.title,
                    cover_url: selectedAlbum.cover,
                  });
                }}
              />
            ) : (
              <span className="flex aspect-square w-40 shrink-0 items-center justify-center rounded-xl border border-border-strong bg-ink font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:w-44">
                No cover
              </span>
            )}
            <div className="min-w-0 space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {selectedAlbum.artist}
              </p>
              <div className="flex flex-wrap gap-2">
                {selectedAlbum.genre ? (
                  <span className="rounded-full border border-border-strong bg-ink/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {selectedAlbum.genre}
                  </span>
                ) : null}
                <span className="rounded-full border border-border-strong bg-ink/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  {selectedAlbum.tracks.length} tracks
                </span>
                <DivisionBadge division={selectedAlbum.division} />
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {tracks.length === 0
                ? "0 tracks"
                : `${pageStart + 1}–${Math.min(pageStart + pageSize, tracks.length)} of ${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
            </p>
            <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Per page
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                aria-label="Tracks per page"
                className="rounded-md border border-border-strong bg-ink/40 px-2 py-1.5 text-xs text-foreground outline-none"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {tokens.signedIn ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-ink/40 px-3 py-2.5">
              {bulkMode ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(ownedTracks.map((t) => t.id)))}
                      className="rounded-md border border-border-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      Select all unlocked ({ownedTracks.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="rounded-md border border-border-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      Clear
                    </button>
                    <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {bulkProgress
                        ? `Downloading ${bulkProgress.done}/${bulkProgress.total}…`
                        : `${selected.size} selected`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={bulkBusy || selected.size === 0}
                      onClick={() => void runBulkDownload()}
                      className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                    >
                      <Download size={13} aria-hidden />
                      {bulkBusy ? "Downloading…" : `Download ${selected.size || ""}`}
                    </button>
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={exitBulk}
                      aria-label="Exit bulk download mode"
                      className="flex size-8 items-center justify-center rounded-md border border-border-strong text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-50"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Grab several unlocked tracks at once
                  </p>
                  <button
                    type="button"
                    onClick={() => setBulkMode(true)}
                    className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-primary hover:text-primary"
                  >
                    <ListChecks size={13} aria-hidden /> Bulk download
                  </button>
                </>
              )}
            </div>
          ) : null}

          <ul className="mt-4 space-y-2">
            {pageTracks.map((t) => {
              const owned = tokens.unlocked.has(t.id);
              const busy = tokens.busyTrack === t.id;
              const isPlaying = playingId === t.id;
              const isActive = activeId === t.id;
              const rowProgress =
                isActive && duration > 0 ? Math.min(1, currentTime / duration) : 0;

              return (
                <li
                  key={t.id}
                  onClick={() => setDetailTrackId(t.id)}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border border-border-strong bg-ink/50 p-3 backdrop-blur transition hover:border-primary/50"
                >
                  {bulkMode ? (
                    <input
                      type="checkbox"
                      checked={selected.has(t.id)}
                      disabled={!owned || bulkBusy}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(t.id)}
                      aria-label={`Select ${t.title} for bulk download`}
                      className="size-4 shrink-0 accent-primary disabled:opacity-40"
                    />
                  ) : null}

                  <span className="w-6 shrink-0 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
                    {t.trackNumber ?? "·"}
                  </span>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      console.log("[artists] play click", {
                        id: t.id,
                        title: t.title,
                        audio_url: t.src,
                        cover_url: t.cover,
                      });
                      preview(t.id, t.src);
                    }}
                    aria-label={`${isPlaying ? "Pause" : "Preview"} ${t.title} by ${t.artist}`}
                    className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border-strong bg-ink/60 text-muted-foreground transition hover:border-primary hover:text-primary"
                  >
                    {isPlaying ? (
                      <Pause size={14} fill="currentColor" />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">{t.title}</p>
                    <p className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                      {t.artist}
                    </p>
                    {isActive ? (
                      <div
                        role="progressbar"
                        aria-label={`Playback progress for ${t.title}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(rowProgress * 100)}
                        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10"
                      >
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${rowProgress * 100}%` }}
                        />
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    disabled={busy || bulkBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void tokens.download(t.id);
                    }}
                    className={`flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-60 ${
                      owned
                        ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/20"
                        : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
                    }`}
                  >
                    {owned ? <Check size={13} aria-hidden /> : <Download size={13} aria-hidden />}
                    {busy ? "Working…" : owned ? "Download" : "1 token"}
                  </button>
                </li>
              );
            })}
          </ul>

          {tracks.length === 0 ? (
            <p className="mt-6 text-sm text-muted-foreground">No tracks match that search.</p>
          ) : null}

          {totalPages > 1 ? (
            <nav
              aria-label="Track pagination"
              className="mt-5 flex flex-wrap items-center justify-center gap-2"
            >
              <button
                type="button"
                onClick={() => setPage(Math.max(1, safePage - 1))}
                disabled={safePage === 1}
                className="rounded-md border border-border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-40"
              >
                Prev
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((n) => n === 1 || n === totalPages || Math.abs(n - safePage) <= 1)
                .map((n, i, arr) => (
                  <span key={n} className="flex items-center gap-2">
                    {i > 0 && n - (arr[i - 1] as number) > 1 ? (
                      <span className="font-mono text-[10px] text-muted-foreground">…</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setPage(n)}
                      aria-current={n === safePage ? "page" : undefined}
                      className={`min-w-9 rounded-md border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] transition ${
                        n === safePage
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border-strong text-muted-foreground hover:border-primary hover:text-primary"
                      }`}
                    >
                      {n}
                    </button>
                  </span>
                ))}
              <button
                type="button"
                onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                disabled={safePage === totalPages}
                className="rounded-md border border-border-strong px-3 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground transition hover:border-primary hover:text-primary disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}

      {/* Track details drawer */}
      <Sheet open={detailTrack !== null} onOpenChange={(open) => !open && setDetailTrackId(null)}>
        <SheetContent className="flex w-full flex-col gap-5 studio-glass sm:max-w-md">
          {detailTrack ? (
            <>
              <SheetHeader className="space-y-3 text-start">
                {detailTrack.cover ? (
                  <CoverImage
                    src={detailTrack.cover}
                    alt={`${detailTrack.title} cover art`}
                    sizes="(min-width: 640px) 28rem, 100vw"
                    width={640}
                    height={640}
                    className="aspect-square w-full rounded-xl border border-border-strong object-cover shadow-2xl"
                    onError={() => {
                      console.warn("[artists] track detail cover failed:", {
                        id: detailTrack.id,
                        cover_url: detailTrack.cover,
                      });
                    }}
                  />
                ) : null}
                <SheetTitle className="font-display text-xl uppercase tracking-[0.12em] text-foreground">
                  {detailTrack.title}
                </SheetTitle>
                <SheetDescription className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  {detailTrack.artist}
                  {detailTrack.album ? ` · ${detailTrack.album}` : ""}
                </SheetDescription>
              </SheetHeader>

              <div className="flex flex-wrap gap-2">
                {detailTrack.genre ? (
                  <span className="rounded-full border border-border-strong bg-ink/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {detailTrack.genre}
                  </span>
                ) : null}
                {detailTrack.trackNumber && detailTrack.trackTotal ? (
                  <span className="rounded-full border border-border-strong bg-ink/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    Track {detailTrack.trackNumber} of {detailTrack.trackTotal}
                  </span>
                ) : null}
                <DivisionBadge division={detailTrack.division} />
              </div>

              {detailTrack.credits ? (
                <div className="space-y-2">
                  <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Credits
                  </h3>
                  <p className="text-sm leading-relaxed text-foreground">{detailTrack.credits}</p>
                </div>
              ) : null}

              <div className="mt-auto flex flex-col gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    const owned = tokens.unlocked.has(detailTrack.id);
                    void tokens.download(detailTrack.id);
                    if (!owned) setDetailTrackId(null);
                  }}
                  disabled={tokens.busyTrack === detailTrack.id}
                  className={`flex w-full items-center justify-center gap-2 rounded-md border px-4 py-3 font-mono text-xs uppercase tracking-[0.18em] transition disabled:opacity-60 ${
                    tokens.unlocked.has(detailTrack.id)
                      ? "border-primary/60 bg-primary/10 text-primary hover:bg-primary/20"
                      : "border-border-strong bg-primary text-primary-foreground hover:opacity-90"
                  }`}
                >
                  {tokens.unlocked.has(detailTrack.id) ? (
                    <>
                      <Download size={14} aria-hidden /> Download
                    </>
                  ) : tokens.busyTrack === detailTrack.id ? (
                    "Working…"
                  ) : (
                    <>
                      <Download size={14} aria-hidden /> Unlock with 1 token
                    </>
                  )}
                </button>

                <div className="rounded-lg border border-border-strong bg-ink/40 p-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => preview(detailTrack.id, detailTrack.src)}
                      aria-label={`${playingId === detailTrack.id ? "Pause" : "Play"} ${detailTrack.title}`}
                      className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border-strong bg-ink/60 text-muted-foreground transition hover:border-primary hover:text-primary"
                    >
                      {playingId === detailTrack.id ? (
                        <Pause size={16} fill="currentColor" />
                      ) : (
                        <Play size={16} fill="currentColor" />
                      )}
                    </button>
                    <div className="flex-1 space-y-1.5">
                      <input
                        type="range"
                        min={0}
                        max={activeId === detailTrack.id ? Math.max(0, duration || 0) : 0}
                        step={0.1}
                        value={activeId === detailTrack.id ? Math.min(currentTime, duration || 0) : 0}
                        onChange={(e) => seek(parseFloat(e.target.value))}
                        aria-label="Seek preview"
                        className="w-full accent-primary"
                      />
                      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                        <span>{formatTime(activeId === detailTrack.id ? currentTime : 0)}</span>
                        <span>{formatTime(activeId === detailTrack.id ? duration : 0)}</span>
                      </div>
                    </div>

                  </div>

                  <div className="mt-3">
                    <TrackWaveform
                      src={detailTrack.src}
                      trackId={detailTrack.id}
                      currentTime={activeId === detailTrack.id ? currentTime : 0}
                      duration={activeId === detailTrack.id ? duration : 0}
                      onSeek={(t) => {
                        if (activeId !== detailTrack.id) return;
                        seek(t);
                      }}
                    />
                  </div>

                </div>

              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <ArtistTokenStore tokens={tokens} />
    </main>
  );
}

