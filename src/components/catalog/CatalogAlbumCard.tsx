import { CoverImage } from "@/components/CoverImage";
import { omitUnplayableAlbums } from "@/lib/artist-catalog";
import type { Album } from "@/lib/radio-tracks";

const BEAM_GRADIENT = `conic-gradient(from 0deg, transparent 0deg, transparent 260deg, #ef4444 295deg, #ffffff 330deg, #3b82f6 360deg)`;

type CatalogAlbumCardProps = {
  album: Album;
  onOpen: (albumId: string) => void;
  priority?: boolean;
};

export function CatalogAlbumCard({ album, onOpen, priority = false }: CatalogAlbumCardProps) {
  const artist = album.artist.trim() || "Hybrid AI Records";
  const trackCount = album.tracks.length;

  return (
    <button
      type="button"
      onClick={() => onOpen(album.id)}
      aria-label={`Open album ${album.title} by ${artist}`}
      className="relative group w-full cursor-pointer appearance-none border-0 bg-transparent p-0 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div
        aria-hidden="true"
        className="absolute -inset-1 rounded-2xl overflow-hidden pointer-events-none opacity-0 blur-xl transition-all duration-500 group-hover:opacity-75 group-hover:-inset-2"
        style={{ overflow: "clip" }}
      >
        <div
          className="absolute inset-[-150%] animate-border-beam"
          style={{ background: BEAM_GRADIENT }}
        />
      </div>
      <div
        className="relative rounded-2xl p-[1.5px] overflow-hidden shadow-lg transition-transform duration-300 group-hover:-translate-y-1"
        style={{ overflow: "clip" }}
      >
        <div
          aria-hidden="true"
          data-testid="catalog-album-beam"
          className="absolute inset-[-150%] animate-border-beam pointer-events-none opacity-40 group-hover:opacity-100 group-hover:brightness-125 transition-opacity"
          style={{ background: BEAM_GRADIENT }}
        />
        <div className="relative w-full h-full rounded-[calc(1rem-1.5px)] bg-neutral-950/80 backdrop-blur-md border border-white/10 p-4 flex flex-col gap-3">
          <div className="relative overflow-hidden rounded-xl">
            {album.cover ? (
              <CoverImage
                src={album.cover}
                alt={`${album.title} album cover`}
                priority={priority}
                sizes="(min-width: 1024px) 20vw, (min-width: 640px) 30vw, 50vw"
                width={640}
                height={640}
                className="aspect-square w-full rounded-xl object-cover transition-transform duration-300 group-hover:scale-105"
                onError={() => {
                  console.warn("[artists] album card cover failed:", {
                    album: album.title,
                    cover_url: album.cover,
                  });
                }}
              />
            ) : (
              <span className="flex aspect-square w-full items-center justify-center rounded-xl bg-neutral-900 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500">
                No cover
              </span>
            )}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/35 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            >
              <span className="flex size-12 items-center justify-center rounded-full border border-white/40 bg-black/60 text-white shadow-lg">
                ▶
              </span>
            </span>
          </div>
          <div className="min-w-0">
            <span className="block truncate font-bold text-white">{album.title}</span>
            <span className="mt-0.5 block truncate text-xs text-neutral-400">{artist}</span>
            <span className="mt-2 block font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-400">
              {trackCount} Tracks
              {album.genre ? ` · ${album.genre}` : ""}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

export function CatalogAlbumGrid({
  albums,
  onOpen,
}: {
  albums: Album[];
  onOpen: (albumId: string) => void;
}) {
  const visible = omitUnplayableAlbums(albums);
  return (
    <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {visible.map((album, index) => (
        <li key={album.id}>
          <CatalogAlbumCard album={album} onOpen={onOpen} priority={index < 4} />
        </li>
      ))}
    </ul>
  );
}
